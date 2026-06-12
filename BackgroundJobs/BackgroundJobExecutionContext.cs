using System.Text.Json;
using games_vault.Data;
using games_vault.Models;
using Microsoft.Extensions.Logging;

namespace games_vault.BackgroundJobs;

public sealed class BackgroundJobExecutionContext(
    BackgroundJob job,
    AppDbContext db,
    IServiceProvider services,
    ILogger logger)
{
    private int _pendingLogEntries;

    public BackgroundJob Job { get; } = job;
    public AppDbContext Db { get; } = db;
    public IServiceProvider Services { get; } = services;
    public ILogger Logger { get; } = logger;

    public async Task SetProgressPermilleAsync(int? progressPermille, CancellationToken cancellationToken)
    {
        if (progressPermille is < 0 or > 1000)
        {
            throw new ArgumentOutOfRangeException(nameof(progressPermille), "Must be between 0 and 1000.");
        }

        Job.ProgressPermille = progressPermille;
        Job.UpdatedUtc = DateTime.UtcNow;
        await Db.SaveChangesAsync(cancellationToken);
    }

    public async Task TouchLeaseAsync(TimeSpan extendBy, CancellationToken cancellationToken)
    {
        Job.LockedUntilUtc = DateTime.UtcNow.Add(extendBy);
        Job.UpdatedUtc = DateTime.UtcNow;
        await Db.SaveChangesAsync(cancellationToken);
    }

    public async Task LogInfoAsync(string message, CancellationToken cancellationToken)
    {
        Logger.LogInformation("{Message}", message);
        await WriteLogEntryAsync("Information", message, cancellationToken);
    }

    public async Task LogWarnAsync(string message, CancellationToken cancellationToken)
    {
        Logger.LogWarning("{Message}", message);
        await WriteLogEntryAsync("Warning", message, cancellationToken);
    }

    public async Task LogErrorAsync(string message, CancellationToken cancellationToken)
    {
        Logger.LogError("{Message}", message);
        await WriteLogEntryAsync("Error", message, cancellationToken);
    }

    private async Task WriteLogEntryAsync(string level, string message, CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(message))
        {
            return;
        }

        message = message.Trim();
        if (message.Length > 4000)
        {
            message = message[..4000];
        }

        Db.BackgroundJobLogEntries.Add(new BackgroundJobLogEntry
        {
            BackgroundJobId = Job.Id,
            Level = level,
            Message = message,
            CreatedUtc = DateTime.UtcNow
        });

        Job.UpdatedUtc = DateTime.UtcNow;

        if (++_pendingLogEntries >= 50)
        {
            await Db.SaveChangesAsync(cancellationToken);
            _pendingLogEntries = 0;
        }
    }

    public async Task FlushLogEntriesAsync(CancellationToken cancellationToken)
    {
        if (_pendingLogEntries > 0)
        {
            await Db.SaveChangesAsync(cancellationToken);
            _pendingLogEntries = 0;
        }
    }
}
