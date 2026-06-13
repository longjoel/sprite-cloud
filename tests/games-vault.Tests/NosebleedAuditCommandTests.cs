using System.Diagnostics;
using System.Text;
using System.Text.Json;
using games_vault.BackgroundJobs;
using games_vault.BackgroundJobs.Commands;
using games_vault.Data;
using games_vault.Models;
using games_vault.Nosebleed;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using Npgsql;

namespace games_vault.Tests;

public sealed class NosebleedAuditCommandTests : IAsyncLifetime
{
    private TestDbFixture.Scope _scope = null!;
    private AppDbContext _db = null!;
    private string _adminConnectionString = null!;
    private static readonly Lazy<IServiceProvider> _emptyServices = new(() => new ServiceCollection().BuildServiceProvider());

    public async Task InitializeAsync()
    {
        _scope = await TestDbFixture.CreateScopeAsync();
        _db = _scope.Db;
        var builder = new NpgsqlConnectionStringBuilder(_scope.AdminConnectionString)
        {
            Database = _scope.DatabaseName
        };
        _adminConnectionString = builder.ConnectionString;
    }

    public async Task DisposeAsync()
    {
        await _scope.DisposeAsync().AsTask();
    }

    [Fact]
    public async Task ExecuteAsync_AuditMode_ReportsOrphansWithoutKilling()
    {
        var tempRoot = CreateTempDirectory();
        Process? process = null;
        NosebleedSessionManager? sessionManager = null;

        try
        {
            var options = CreateOptions(tempRoot);
            var inspector = new NosebleedProcessInspector(options);
            var seatManager = new NosebleedSeatManager(options);

            process = StartFakeNosebleedProcess(
                options.Value.BinaryPath,
                $"games-vault-orphan-{Guid.NewGuid():N}",
                19001,
                Path.Combine(tempRoot, "core.so"),
                Path.Combine(tempRoot, "content.rom"));

            await Task.Delay(300, CancellationToken.None);

            sessionManager = CreateSessionManager(options, inspector, seatManager);

            var job = await CreateJobAsync("nosebleed.audit", new NosebleedAuditPayload(Cleanup: false));

            await using var execDb = new AppDbContext(new DbContextOptionsBuilder<AppDbContext>()
                .UseNpgsql(_adminConnectionString).Options);
            var reloaded = await execDb.BackgroundJobs.FindAsync(job.Id);
            Assert.NotNull(reloaded);
            var context = new BackgroundJobExecutionContext(reloaded, execDb, _emptyServices.Value, NullLogger<BackgroundJobWorker>.Instance);
            var command = new NosebleedAuditCommand(inspector, sessionManager);
            var payload = JsonSerializer.SerializeToDocument(new NosebleedAuditPayload(Cleanup: false));
            await command.ExecuteAsync(context, payload.RootElement, CancellationToken.None);
            await context.FlushLogEntriesAsync(CancellationToken.None);

            // Audit mode should not kill the process
            Assert.False(process.HasExited);

            // Check log entries — should report orphan but never say "killed a pid" (summary says "would be killed" but that's future-tense advisory)
            var logs = await execDb.BackgroundJobLogEntries
                .Where(l => l.BackgroundJobId == reloaded.Id)
                .OrderBy(l => l.Id)
                .Select(l => l.Message)
                .ToListAsync();

            Assert.Contains(logs, l => l.Contains("unmanaged"));
            Assert.DoesNotContain(logs, l => l.Contains("Killed PID"));
        }
        finally
        {
            sessionManager?.Dispose();
            TryKill(process);
            DeleteDirectory(tempRoot);
        }
    }

    [Fact]
    public async Task ExecuteAsync_CleanupMode_KillsOrphanProcesses()
    {
        var tempRoot = CreateTempDirectory();
        Process? process = null;
        NosebleedSessionManager? sessionManager = null;

        try
        {
            var options = CreateOptions(tempRoot);
            var inspector = new NosebleedProcessInspector(options);
            var seatManager = new NosebleedSeatManager(options);

            process = StartFakeNosebleedProcess(
                options.Value.BinaryPath,
                $"games-vault-orphan-cleanup-{Guid.NewGuid():N}",
                19002,
                Path.Combine(tempRoot, "core.so"),
                Path.Combine(tempRoot, "content.rom"));

            await Task.Delay(300, CancellationToken.None);

            sessionManager = CreateSessionManager(options, inspector, seatManager);

            var job = await CreateJobAsync("nosebleed.audit", new NosebleedAuditPayload(Cleanup: true));

            await using var execDb = new AppDbContext(new DbContextOptionsBuilder<AppDbContext>()
                .UseNpgsql(_adminConnectionString).Options);
            var reloaded = await execDb.BackgroundJobs.FindAsync(job.Id);
            Assert.NotNull(reloaded);
            var context = new BackgroundJobExecutionContext(reloaded, execDb, _emptyServices.Value, NullLogger<BackgroundJobWorker>.Instance);
            var command = new NosebleedAuditCommand(inspector, sessionManager);
            var payload = JsonSerializer.SerializeToDocument(new NosebleedAuditPayload(Cleanup: true));
            await command.ExecuteAsync(context, payload.RootElement, CancellationToken.None);
            await context.FlushLogEntriesAsync(CancellationToken.None);

            // Cleanup mode should kill the orphan
            Assert.True(process.WaitForExit(5000));

            var logs = await execDb.BackgroundJobLogEntries
                .Where(l => l.BackgroundJobId == reloaded.Id)
                .OrderBy(l => l.Id)
                .Select(l => l.Message)
                .ToListAsync();

            Assert.Contains(logs, l => l.Contains("Killed"));
        }
        finally
        {
            sessionManager?.Dispose();
            TryKill(process);
            DeleteDirectory(tempRoot);
        }
    }

    [Fact]
    public async Task ExecuteAsync_AuditMode_SkipsManagedProcesses()
    {
        var tempRoot = CreateTempDirectory();
        Process? process = null;
        NosebleedSessionManager? sessionManager = null;

        try
        {
            var options = CreateOptions(tempRoot);
            var inspector = new NosebleedProcessInspector(options);
            var seatManager = new NosebleedSeatManager(options);

            var sessionId = $"games-vault-managed-{Guid.NewGuid():N}";
            var corePath = Path.Combine(tempRoot, "managed-core.so");
            var contentPath = Path.Combine(tempRoot, "managed-content.rom");
            await File.WriteAllTextAsync(corePath, "managed-core");
            await File.WriteAllTextAsync(contentPath, "managed-content");

            process = StartFakeNosebleedProcess(
                options.Value.BinaryPath,
                sessionId,
                19003,
                corePath,
                contentPath);

            await Task.Delay(300, CancellationToken.None);

            sessionManager = CreateSessionManager(options, inspector, seatManager);

            // Seed the process as managed via reflection
            var session = new NosebleedSession(
                sessionId, 1, 1, 19003, "http://127.0.0.1:19003", null, null,
                DateTimeOffset.UtcNow, corePath, contentPath);
            SeedManagedSession(sessionManager, "test-managed", session, process);

            var job = await CreateJobAsync("nosebleed.audit", new NosebleedAuditPayload(Cleanup: false));

            await using var execDb = new AppDbContext(new DbContextOptionsBuilder<AppDbContext>()
                .UseNpgsql(_adminConnectionString).Options);
            var reloaded = await execDb.BackgroundJobs.FindAsync(job.Id);
            Assert.NotNull(reloaded);
            var context = new BackgroundJobExecutionContext(reloaded, execDb, _emptyServices.Value, NullLogger<BackgroundJobWorker>.Instance);
            var command = new NosebleedAuditCommand(inspector, sessionManager);
            var payload = JsonSerializer.SerializeToDocument(new NosebleedAuditPayload(Cleanup: false));
            await command.ExecuteAsync(context, payload.RootElement, CancellationToken.None);
            await context.FlushLogEntriesAsync(CancellationToken.None);

            // Should not have killed managed process
            Assert.False(process.HasExited);

            var logs = await execDb.BackgroundJobLogEntries
                .Where(l => l.BackgroundJobId == reloaded.Id)
                .OrderBy(l => l.Id)
                .Select(l => l.Message)
                .ToListAsync();

            // Should report it as managed
            Assert.Contains(logs, l => l.Contains("managed") && l.Contains(sessionId));
        }
        finally
        {
            sessionManager?.Dispose();
            TryKill(process);
            DeleteDirectory(tempRoot);
        }
    }

    [Fact]
    public async Task ExecuteAsync_EmptyPayload_Skips()
    {
        var tempRoot = CreateTempDirectory();
        var options = CreateOptions(tempRoot);
        var inspector = new NosebleedProcessInspector(options);
        var seatManager = new NosebleedSeatManager(options);
        var sessionManager = CreateSessionManager(options, inspector, seatManager);
        try
        {
            var job = await CreateJobAsync("nosebleed.audit", new { });

            await using var execDb = new AppDbContext(new DbContextOptionsBuilder<AppDbContext>()
                .UseNpgsql(_adminConnectionString).Options);
            var reloaded = await execDb.BackgroundJobs.FindAsync(job.Id);
            Assert.NotNull(reloaded);
            var context = new BackgroundJobExecutionContext(reloaded, execDb, _emptyServices.Value, NullLogger<BackgroundJobWorker>.Instance);
            var command = new NosebleedAuditCommand(inspector, sessionManager);
            var payload = JsonSerializer.SerializeToDocument((object?)null);
            await command.ExecuteAsync(context, payload.RootElement, CancellationToken.None);
            await context.FlushLogEntriesAsync(CancellationToken.None);

            var logs = await execDb.BackgroundJobLogEntries
                .Where(l => l.BackgroundJobId == reloaded.Id)
                .OrderBy(l => l.Id)
                .Select(l => l.Message)
                .ToListAsync();

            Assert.Contains(logs, l => l.Contains("null payload"));
        }
        finally
        {
            sessionManager.Dispose();
            DeleteDirectory(tempRoot);
        }
    }

    // ── Helpers ──

    private async Task<BackgroundJob> CreateJobAsync(string command, object payload)
    {
        var job = new BackgroundJob
        {
            Command = command,
            PayloadJson = JsonSerializer.Serialize(payload),
            Status = BackgroundJobStatus.Queued,
            MaxAttempts = 1,
            Attempt = 0,
            CreatedUtc = DateTime.UtcNow,
            UpdatedUtc = DateTime.UtcNow
        };
        _db.BackgroundJobs.Add(job);
        await _db.SaveChangesAsync();
        return job;
    }

    private static NosebleedSessionManager CreateSessionManager(
        IOptions<NosebleedOptions> options,
        NosebleedProcessInspector inspector,
        NosebleedSeatManager seatManager)
    {
        var services = new ServiceCollection();
        var serviceProvider = services.BuildServiceProvider();

        return new NosebleedSessionManager(
            options,
            serviceProvider.GetRequiredService<IServiceScopeFactory>(),
            new NosebleedTicketSigner(options, NullLogger<NosebleedTicketSigner>.Instance),
            new NoopHttpClientFactory(),
            new SystemCoreMappingResolver(options),
            inspector,
            seatManager,
            NullLogger<NosebleedSessionManager>.Instance);
    }

    private static IOptions<NosebleedOptions> CreateOptions(string tempRoot)
    {
        var binaryPath = Path.Combine(tempRoot, "fake-nosebleed.sh");
        File.WriteAllText(binaryPath, "#!/usr/bin/env bash\ntrap 'exit 0' TERM INT\nwhile true; do sleep 5; done\n", new UTF8Encoding(false));
        var chmod = Process.Start(new ProcessStartInfo("chmod", $"+x \"{binaryPath}\"")
        {
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true
        })!;
        chmod.WaitForExit();

        return Options.Create(new NosebleedOptions
        {
            Enabled = true,
            BinaryPath = binaryPath,
            PublicScheme = "http",
            PublicHost = "127.0.0.1",
            SessionRoot = Path.Combine(tempRoot, "sessions")
        });
    }

    private static Process StartFakeNosebleedProcess(string binaryPath, string sessionId, int port, string corePath, string contentPath)
    {
        var psi = new ProcessStartInfo
        {
            FileName = binaryPath,
            UseShellExecute = false,
            RedirectStandardOutput = false,
            RedirectStandardError = false,
        };
        psi.ArgumentList.Add("--listen");
        psi.ArgumentList.Add($"0.0.0.0:{port}");
        psi.ArgumentList.Add("--core");
        psi.ArgumentList.Add(corePath);
        psi.ArgumentList.Add("--content");
        psi.ArgumentList.Add(contentPath);
        psi.ArgumentList.Add("--session-id");
        psi.ArgumentList.Add(sessionId);
        return Process.Start(psi)!;
    }

    private static void SeedManagedSession(NosebleedSessionManager manager, string key, NosebleedSession session, Process process)
    {
        var field = typeof(NosebleedSessionManager).GetField("_sessions", System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.NonPublic)
            ?? throw new InvalidOperationException("Could not find NosebleedSessionManager._sessions field.");
        var dictionary = field.GetValue(manager)
            ?? throw new InvalidOperationException("Could not read NosebleedSessionManager._sessions value.");

        var managedSessionType = typeof(NosebleedSessionManager).GetNestedType("ManagedSession", System.Reflection.BindingFlags.NonPublic)
            ?? throw new InvalidOperationException("Could not find ManagedSession nested type.");
        var managedSession = Activator.CreateInstance(managedSessionType, session, process)
            ?? throw new InvalidOperationException("Could not construct ManagedSession.");

        var tryAdd = dictionary.GetType().GetMethod("TryAdd")
            ?? throw new InvalidOperationException("Could not find ConcurrentDictionary.TryAdd.");
        var added = (bool)(tryAdd.Invoke(dictionary, new object[] { key, managedSession }) ?? false);
        if (!added)
        {
            throw new InvalidOperationException("Failed to seed active Nosebleed session into manager.");
        }
    }

    private static string CreateTempDirectory()
    {
        var path = Path.Combine(Path.GetTempPath(), $"gv-audit-{Guid.NewGuid():N}");
        Directory.CreateDirectory(path);
        return path;
    }

    private static void DeleteDirectory(string path)
    {
        try { if (Directory.Exists(path)) Directory.Delete(path, recursive: true); }
        catch { }
    }

    private static void TryKill(Process? process)
    {
        if (process is null) return;
        try
        {
            if (!process.HasExited)
            {
                process.Kill(entireProcessTree: true);
                process.WaitForExit(5000);
            }
        }
        catch { }
        finally { process.Dispose(); }
    }

    private sealed class NoopHttpClientFactory : IHttpClientFactory
    {
        public HttpClient CreateClient(string name) => new();
    }
}
