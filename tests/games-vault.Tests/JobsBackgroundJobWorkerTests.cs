using System.Text.Json;
using games_vault.BackgroundJobs;
using games_vault.Data;
using games_vault.Models;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using Npgsql;

namespace games_vault.Tests;

/// <summary>
/// Test command that records execution for assertions.
/// </summary>
public sealed class TestJobCommand : IBackgroundJobCommand
{
    public static readonly List<(BackgroundJobExecutionContext Context, JsonElement Payload)> Executions = [];

    public Task ExecuteAsync(BackgroundJobExecutionContext context, JsonElement payload, CancellationToken cancellationToken)
    {
        Executions.Add((context, payload.Clone()));
        return Task.CompletedTask;
    }
}

/// <summary>
/// Test command that throws to test failure/retry logic.
/// </summary>
public sealed class FailingJobCommand : IBackgroundJobCommand
{
    public Task ExecuteAsync(BackgroundJobExecutionContext context, JsonElement payload, CancellationToken cancellationToken)
    {
        throw new InvalidOperationException("Simulated failure");
    }
}

public sealed class JobsBackgroundJobWorkerTests : IAsyncLifetime
{
    private readonly TestDbFixture.Scope _scope;
    private readonly AppDbContext _db;
    private readonly string _testConnectionString;

    public JobsBackgroundJobWorkerTests()
    {
        _scope = TestDbFixture.CreateScopeAsync().GetAwaiter().GetResult();
        _db = _scope.Db;

        // Build a test-specific connection string from the admin connection + test database name
        var builder = new NpgsqlConnectionStringBuilder(_scope.AdminConnectionString)
        {
            Database = _scope.DatabaseName
        };
        _testConnectionString = builder.ConnectionString;
    }

    public async Task InitializeAsync()
    {
        TestJobCommand.Executions.Clear();
    }

    public async Task DisposeAsync()
    {
        await _scope.DisposeAsync().AsTask();
    }

    // ── Enqueue ──

    [Fact]
    public async Task EnqueueAsync_CreatesJobWithDefaults()
    {
        var client = new BackgroundJobClient(_db);
        var jobId = await client.EnqueueAsync("test.command", new { value = 42 });

        var job = await _db.BackgroundJobs.FindAsync(jobId);
        Assert.NotNull(job);
        Assert.Equal("test.command", job.Command);
        Assert.Equal(BackgroundJobStatus.Queued, job.Status);
        Assert.Equal(3, job.MaxAttempts);
        Assert.Equal(0, job.Attempt);
        Assert.NotEqual(default, job.CreatedUtc);
        Assert.NotEqual(default, job.UpdatedUtc);
    }

    [Fact]
    public async Task EnqueueAsync_ThrowsOnEmptyCommand()
    {
        var client = new BackgroundJobClient(_db);
        var ex = await Assert.ThrowsAsync<ArgumentException>(() =>
            client.EnqueueAsync("", new { }));
        Assert.Contains("Command name", ex.Message);
    }

    [Fact]
    public async Task EnqueueAsync_AcceptsCustomMaxAttempts()
    {
        var client = new BackgroundJobClient(_db);
        var jobId = await client.EnqueueAsync("test.command", new { }, maxAttempts: 5);

        var job = await _db.BackgroundJobs.FindAsync(jobId);
        Assert.NotNull(job);
        Assert.Equal(5, job.MaxAttempts);
    }

    [Fact]
    public async Task EnqueueAsync_SerializesPayload()
    {
        var client = new BackgroundJobClient(_db);
        var jobId = await client.EnqueueAsync("test.command", new { gameId = 7, force = true });

        var job = await _db.BackgroundJobs.FindAsync(jobId);
        Assert.NotNull(job);
        Assert.Contains("\"gameId\":7", job.PayloadJson);
        Assert.Contains("\"force\":true", job.PayloadJson);
    }

    // ── Worker ──

    [Fact]
    public async Task Worker_ExecutesRegisteredCommand()
    {
        var services = CreateServices(new Dictionary<string, Type>
        {
            ["test.command"] = typeof(TestJobCommand)
        });

        var client = services.GetRequiredService<IBackgroundJobClient>();
        var jobId = await client.EnqueueAsync("test.command", new { });

        var worker = new BackgroundJobWorker(
            services,
            services.GetRequiredService<BackgroundJobCommandRegistry>(),
            NullLogger<BackgroundJobWorker>.Instance);

        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        await worker.StartAsync(cts.Token);

        // Give the worker a moment to pick up the job
        await Task.Delay(500, CancellationToken.None);

        await worker.StopAsync(cts.Token);

        // Re-read from a fresh context to get persisted state
        await using var freshDb = new AppDbContext(new DbContextOptionsBuilder<AppDbContext>()
            .UseNpgsql(_testConnectionString).Options);
        var job = await freshDb.BackgroundJobs.FindAsync(jobId);
        Assert.NotNull(job);
        Assert.Equal(BackgroundJobStatus.Succeeded, job.Status);
        Assert.NotNull(job.CompletedUtc);
    }

    [Fact]
    public async Task Worker_FailsOnUnknownCommand()
    {
        var services = CreateServices(new Dictionary<string, Type>());

        var client = services.GetRequiredService<IBackgroundJobClient>();
        var jobId = await client.EnqueueAsync("nonexistent.command", new { });

        var worker = new BackgroundJobWorker(
            services,
            services.GetRequiredService<BackgroundJobCommandRegistry>(),
            NullLogger<BackgroundJobWorker>.Instance);

        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        await worker.StartAsync(cts.Token);
        await Task.Delay(500, CancellationToken.None);
        await worker.StopAsync(cts.Token);

        await using var freshDb = new AppDbContext(new DbContextOptionsBuilder<AppDbContext>()
            .UseNpgsql(_testConnectionString).Options);
        var job = await freshDb.BackgroundJobs.FindAsync(jobId);
        Assert.NotNull(job);
        Assert.Equal(BackgroundJobStatus.Failed, job.Status);
        Assert.Contains("Unknown command", job.LastError ?? "");
    }

    [Fact]
    public async Task Worker_RetriesThenFailsOnPersistentFailure()
    {
        var services = CreateServices(new Dictionary<string, Type>
        {
            ["failing.command"] = typeof(FailingJobCommand)
        });

        var client = services.GetRequiredService<IBackgroundJobClient>();
        // 1 attempt = no retries, so it should just fail once
        var jobId = await client.EnqueueAsync("failing.command", new { }, maxAttempts: 1);

        var worker = new BackgroundJobWorker(
            services,
            services.GetRequiredService<BackgroundJobCommandRegistry>(),
            NullLogger<BackgroundJobWorker>.Instance);

        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        await worker.StartAsync(cts.Token);
        await Task.Delay(1500, CancellationToken.None);
        await worker.StopAsync(cts.Token);

        await using var freshDb = new AppDbContext(new DbContextOptionsBuilder<AppDbContext>()
            .UseNpgsql(_testConnectionString).Options);
        var job = await freshDb.BackgroundJobs.FindAsync(jobId);
        Assert.NotNull(job);
        Assert.Equal(BackgroundJobStatus.Failed, job.Status);
        Assert.Equal(1, job.Attempt);
        Assert.Contains("Simulated failure", job.LastError ?? "");
    }

    // ── Retry ──

    [Fact]
    public async Task RetryAsync_ResetsFailedJob()
    {
        var job = new BackgroundJob
        {
            Command = "test.command",
            PayloadJson = "{}",
            Status = BackgroundJobStatus.Failed,
            Attempt = 3,
            MaxAttempts = 3,
            LastError = "Something went wrong",
            StartedUtc = DateTime.UtcNow.AddMinutes(-10),
            CompletedUtc = DateTime.UtcNow,
            UpdatedUtc = DateTime.UtcNow,
            CreatedUtc = DateTime.UtcNow.AddMinutes(-10)
        };
        _db.BackgroundJobs.Add(job);
        await _db.SaveChangesAsync();

        // Simulate what JobsController.Retry does
        job.Status = BackgroundJobStatus.Queued;
        job.Attempt = 0;
        job.ProgressPermille = null;
        job.LastError = null;
        job.LockedBy = null;
        job.LockedUntilUtc = null;
        job.StartedUtc = null;
        job.CompletedUtc = null;
        job.UpdatedUtc = DateTime.UtcNow;
        await _db.SaveChangesAsync();

        var reloaded = await _db.BackgroundJobs.FindAsync(job.Id);
        Assert.NotNull(reloaded);
        Assert.Equal(BackgroundJobStatus.Queued, reloaded.Status);
        Assert.Equal(0, reloaded.Attempt);
        Assert.Null(reloaded.LastError);
        Assert.Null(reloaded.StartedUtc);
        Assert.Null(reloaded.CompletedUtc);
    }

    // ── Helpers ──

    private IServiceProvider CreateServices(Dictionary<string, Type> commands)
    {
        var services = new ServiceCollection();
        services.AddDbContext<AppDbContext>(options =>
            options.UseNpgsql(_testConnectionString));

        services.AddScoped<IBackgroundJobClient, BackgroundJobClient>();
        services.AddSingleton(new BackgroundJobCommandRegistry(commands));

        foreach (var (_, cmdType) in commands)
        {
            services.AddTransient(cmdType);
        }

        return services.BuildServiceProvider();
    }
}
