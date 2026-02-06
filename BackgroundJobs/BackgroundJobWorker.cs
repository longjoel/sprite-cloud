using System.Text.Json;
using games_vault.Data;
using games_vault.Models;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace games_vault.BackgroundJobs;

public sealed class BackgroundJobWorker(
    IServiceProvider services,
    BackgroundJobCommandRegistry registry,
    ILogger<BackgroundJobWorker> logger) : BackgroundService
{
    private static readonly TimeSpan PollInterval = TimeSpan.FromSeconds(1);
    private static readonly TimeSpan LeaseDuration = TimeSpan.FromMinutes(5);
    private static readonly TimeSpan LeaseHeartbeatInterval = TimeSpan.FromSeconds(45);
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);

    private readonly string _workerId = $"worker:{Environment.MachineName}:{Guid.NewGuid():N}";

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        using var timer = new PeriodicTimer(PollInterval);

        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                await ProcessNextJobAsync(stoppingToken);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                break;
            }
            catch (Exception ex)
            {
                logger.LogError(ex, "Background job worker loop error");
            }

            await timer.WaitForNextTickAsync(stoppingToken);
        }
    }

    private async Task ProcessNextJobAsync(CancellationToken cancellationToken)
    {
        await using var scope = services.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();

        var job = await TryClaimNextJobAsync(db, cancellationToken);
        if (job is null)
        {
            return;
        }

        if (!registry.TryGetCommandType(job.Command, out var commandType))
        {
            await FailAsync(db, job.Id, $"Unknown command '{job.Command}'.", cancellationToken);
            return;
        }

        var command = (IBackgroundJobCommand)scope.ServiceProvider.GetRequiredService(commandType);

        JsonDocument payloadDoc;
        try
        {
            payloadDoc = JsonDocument.Parse(job.PayloadJson);
        }
        catch (Exception ex)
        {
            await FailAsync(db, job.Id, $"Invalid payload JSON: {ex.Message}", cancellationToken);
            return;
        }

        using (payloadDoc)
        {
            var execContext = new BackgroundJobExecutionContext(job, db, scope.ServiceProvider, logger);

            using var heartbeatCts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            var heartbeatTask = RunLeaseHeartbeatAsync(job.Id, heartbeatCts.Token);

            try
            {
                await command.ExecuteAsync(execContext, payloadDoc.RootElement, cancellationToken);
                await SucceedAsync(db, job.Id, cancellationToken);
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                throw;
            }
            catch (Exception ex)
            {
                await HandleFailureAsync(db, job.Id, ex, cancellationToken);
            }
            finally
            {
                heartbeatCts.Cancel();
                try { await heartbeatTask; } catch { }
            }
        }
    }

    private async Task<BackgroundJob?> TryClaimNextJobAsync(AppDbContext db, CancellationToken cancellationToken)
    {
        var now = DateTime.UtcNow;

        await using var tx = await db.Database.BeginTransactionAsync(cancellationToken);

        var job = await db.BackgroundJobs
            .Where(x =>
                x.Status == BackgroundJobStatus.Queued &&
                (x.LockedUntilUtc == null || x.LockedUntilUtc < now))
            .OrderBy(x => x.CreatedUtc)
            .FirstOrDefaultAsync(cancellationToken);

        if (job is null)
        {
            await tx.RollbackAsync(cancellationToken);
            return null;
        }

        job.Status = BackgroundJobStatus.Running;
        job.Attempt += 1;
        job.LockedBy = _workerId;
        job.LockedUntilUtc = now.Add(LeaseDuration);
        job.StartedUtc ??= now;
        job.UpdatedUtc = now;

        await db.SaveChangesAsync(cancellationToken);
        await tx.CommitAsync(cancellationToken);

        logger.LogInformation("Claimed job {JobId} ({Command}) attempt {Attempt}/{MaxAttempts}", job.Id, job.Command, job.Attempt, job.MaxAttempts);
        return job;
    }

    private async Task RunLeaseHeartbeatAsync(int jobId, CancellationToken cancellationToken)
    {
        using var timer = new PeriodicTimer(LeaseHeartbeatInterval);
        while (!cancellationToken.IsCancellationRequested)
        {
            try
            {
                await timer.WaitForNextTickAsync(cancellationToken);
            }
            catch (OperationCanceledException)
            {
                break;
            }

            var now = DateTime.UtcNow;
            await using var scope = services.CreateAsyncScope();
            var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();

            // Only extend lease for the currently running job owned by this worker.
            await db.BackgroundJobs
                .Where(x => x.Id == jobId && x.Status == BackgroundJobStatus.Running && x.LockedBy == _workerId)
                .ExecuteUpdateAsync(setters => setters
                    .SetProperty(x => x.LockedUntilUtc, now.Add(LeaseDuration))
                    .SetProperty(x => x.UpdatedUtc, now), cancellationToken);
        }
    }

    private async Task SucceedAsync(AppDbContext db, int jobId, CancellationToken cancellationToken)
    {
        var now = DateTime.UtcNow;
        var updated = await db.BackgroundJobs
            .Where(x => x.Id == jobId && x.Status == BackgroundJobStatus.Running && x.LockedBy == _workerId)
            .ExecuteUpdateAsync(setters => setters
                .SetProperty(x => x.Status, BackgroundJobStatus.Succeeded)
                .SetProperty(x => x.CompletedUtc, now)
                .SetProperty(x => x.LockedBy, (string?)null)
                .SetProperty(x => x.LockedUntilUtc, (DateTime?)null)
                .SetProperty(x => x.ProgressPermille, 1000)
                .SetProperty(x => x.UpdatedUtc, now), cancellationToken);

        if (updated == 0)
        {
            logger.LogInformation("Job {JobId} completion skipped (status changed or lock lost)", jobId);
        }
    }

    private async Task FailAsync(AppDbContext db, int jobId, string message, CancellationToken cancellationToken)
    {
        var now = DateTime.UtcNow;
        var updated = await db.BackgroundJobs
            .Where(x => x.Id == jobId && x.Status == BackgroundJobStatus.Running && x.LockedBy == _workerId)
            .ExecuteUpdateAsync(setters => setters
                .SetProperty(x => x.Status, BackgroundJobStatus.Failed)
                .SetProperty(x => x.CompletedUtc, now)
                .SetProperty(x => x.LastError, message)
                .SetProperty(x => x.LockedBy, (string?)null)
                .SetProperty(x => x.LockedUntilUtc, (DateTime?)null)
                .SetProperty(x => x.UpdatedUtc, now), cancellationToken);

        if (updated == 0)
        {
            logger.LogInformation("Job {JobId} failure skipped (status changed or lock lost)", jobId);
        }
    }

    private async Task HandleFailureAsync(AppDbContext db, int jobId, Exception ex, CancellationToken cancellationToken)
    {
        var now = DateTime.UtcNow;
        var state = await db.BackgroundJobs
            .AsNoTracking()
            .Where(x => x.Id == jobId)
            .Select(x => new { x.Attempt, x.MaxAttempts, x.Status, x.LockedBy })
            .FirstOrDefaultAsync(cancellationToken);

        if (state is null)
        {
            return;
        }

        if (state.Status != BackgroundJobStatus.Running || state.LockedBy != _workerId)
        {
            logger.LogInformation("Job {JobId} failure handling skipped (status changed or lock lost)", jobId);
            return;
        }

        if (state.Attempt < state.MaxAttempts)
        {
            await db.BackgroundJobs
                .Where(x => x.Id == jobId && x.Status == BackgroundJobStatus.Running && x.LockedBy == _workerId)
                .ExecuteUpdateAsync(setters => setters
                    .SetProperty(x => x.Status, BackgroundJobStatus.Queued)
                    .SetProperty(x => x.LastError, ex.ToString())
                    .SetProperty(x => x.LockedBy, (string?)null)
                    .SetProperty(x => x.LockedUntilUtc, (DateTime?)null)
                    .SetProperty(x => x.UpdatedUtc, now), cancellationToken);

            logger.LogWarning(ex, "Job {JobId} failed; will retry (attempt {Attempt}/{MaxAttempts})", jobId, state.Attempt, state.MaxAttempts);
        }
        else
        {
            await db.BackgroundJobs
                .Where(x => x.Id == jobId && x.Status == BackgroundJobStatus.Running && x.LockedBy == _workerId)
                .ExecuteUpdateAsync(setters => setters
                    .SetProperty(x => x.Status, BackgroundJobStatus.Failed)
                    .SetProperty(x => x.CompletedUtc, now)
                    .SetProperty(x => x.LastError, ex.ToString())
                    .SetProperty(x => x.LockedBy, (string?)null)
                    .SetProperty(x => x.LockedUntilUtc, (DateTime?)null)
                    .SetProperty(x => x.UpdatedUtc, now), cancellationToken);

            logger.LogError(ex, "Job {JobId} failed; no retries left", jobId);
        }
    }
}
