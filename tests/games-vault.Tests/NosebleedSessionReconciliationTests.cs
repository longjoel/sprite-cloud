using System.Diagnostics;
using System.Text;
using games_vault.Data;
using games_vault.Models;
using games_vault.Nosebleed;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;

namespace games_vault.Tests;

public sealed class NosebleedSessionReconciliationTests
{
    [Fact]
    public async Task ReconcileOrphansAsync_AdoptsCabinetOwnedProcess_AndRelinksArcadeRoom()
    {
        await using var scope = await TestDbFixture.CreateScopeAsync();
        var tempRoot = CreateTempDirectory();
        NosebleedSessionManager? sessionManager = null;
        Process? process = null;

        try
        {
            var game = new Game { SystemName = "arcade", Name = "Test Game" };
            scope.Db.Games.Add(game);
            await scope.Db.SaveChangesAsync();

            var gameFile = new GameFile { GameId = game.Id, Name = "test.zip", StoragePath = "library/roms/test.zip" };
            scope.Db.GameFiles.Add(gameFile);

            var arcade = new games_vault.Models.Arcade { Name = "Arcade", Slug = "arcade", IsEnabled = true };
            scope.Db.Arcades.Add(arcade);
            await scope.Db.SaveChangesAsync();

            var sessionId = $"games-vault-{game.Id}-{gameFile.Id}-{Guid.NewGuid():N}";
            var cabinet = new ArcadeCabinet
            {
                ArcadeId = arcade.Id,
                GameId = game.Id,
                GameFileId = gameFile.Id,
                DisplayName = "Cabinet",
                IsEnabled = true,
                RuntimeSessionId = sessionId
            };
            scope.Db.ArcadeCabinets.Add(cabinet);
            await scope.Db.SaveChangesAsync();

            var room = new GamePlayRoom
            {
                Code = "ABCDEF",
                GameId = game.Id,
                GameFileId = gameFile.Id,
                Status = GamePlayRoomStatus.Active,
                IsArcadeBound = true,
                ArcadeCabinetId = cabinet.Id,
                NosebleedSessionId = "stale-room-session"
            };
            scope.Db.GamePlayRooms.Add(room);
            await scope.Db.SaveChangesAsync();

            var options = CreateOptions(tempRoot);
            var processInspector = new NosebleedProcessInspector(options);
            var seatManager = new NosebleedSeatManager(options);
            seatManager.Assign(sessionId, "viewer-1", DateTimeOffset.UtcNow);

            sessionManager = CreateSessionManager(scope.Db, options, processInspector, seatManager);

            var corePath = Path.Combine(tempRoot, "core.so");
            var contentPath = Path.Combine(tempRoot, "game.rom");
            await File.WriteAllTextAsync(corePath, "core");
            await File.WriteAllTextAsync(contentPath, "content");
            process = StartFakeNosebleedProcess(options.Value.BinaryPath, sessionId, 18123, corePath, contentPath);

            var result = await sessionManager.ReconcileOrphansAsync();

            Assert.Equal(1, result.AdoptedSessions);
            Assert.Equal(1, result.RelinkedRooms);
            Assert.True(result.KilledOrphanProcesses >= 0);
            Assert.Contains(sessionManager.GetSessions(), x => x.SessionId == sessionId && x.Port == 18123 && !x.HasExited);
            Assert.Empty(seatManager.GetAssignments(sessionId, DateTimeOffset.UtcNow.AddSeconds(1)));

            var persistedRoom = await scope.Db.GamePlayRooms.SingleAsync(x => x.Id == room.Id);
            var persistedCabinet = await scope.Db.ArcadeCabinets.SingleAsync(x => x.Id == cabinet.Id);
            Assert.Equal(sessionId, persistedRoom.NosebleedSessionId);
            Assert.Equal(sessionId, persistedCabinet.RuntimeSessionId);
            Assert.NotNull(persistedCabinet.LastSeenAliveUtc);
        }
        finally
        {
            sessionManager?.Dispose();
            TryKill(process);
            DeleteDirectory(tempRoot);
        }
    }

    [Fact]
    public async Task ReconcileOrphansAsync_KillsProcess_WhenNoOwnerExists()
    {
        await using var scope = await TestDbFixture.CreateScopeAsync();
        var tempRoot = CreateTempDirectory();
        NosebleedSessionManager? sessionManager = null;
        Process? process = null;

        try
        {
            var options = CreateOptions(tempRoot);
            var processInspector = new NosebleedProcessInspector(options);
            var seatManager = new NosebleedSeatManager(options);
            sessionManager = CreateSessionManager(scope.Db, options, processInspector, seatManager);

            var sessionId = $"games-vault-99-99-{Guid.NewGuid():N}";
            var corePath = Path.Combine(tempRoot, "orphan-core.so");
            var contentPath = Path.Combine(tempRoot, "orphan-game.rom");
            await File.WriteAllTextAsync(corePath, "core");
            await File.WriteAllTextAsync(contentPath, "content");
            process = StartFakeNosebleedProcess(options.Value.BinaryPath, sessionId, 18124, corePath, contentPath);

            var result = await sessionManager.ReconcileOrphansAsync();

            Assert.Equal(0, result.AdoptedSessions);
            Assert.True(result.KilledOrphanProcesses >= 1);
            Assert.True(process.WaitForExit(5000));
            Assert.Empty(sessionManager.GetSessions());
        }
        finally
        {
            sessionManager?.Dispose();
            TryKill(process);
            DeleteDirectory(tempRoot);
        }
    }

    [Fact]
    public async Task ShutdownAsync_KillsManagedProcesses_AndClearsSessions()
    {
        await using var scope = await TestDbFixture.CreateScopeAsync();
        var tempRoot = CreateTempDirectory();
        NosebleedSessionManager? sessionManager = null;
        Process? process = null;

        try
        {
            var options = CreateOptions(tempRoot);
            var processInspector = new NosebleedProcessInspector(options);
            var seatManager = new NosebleedSeatManager(options);
            sessionManager = CreateSessionManager(scope.Db, options, processInspector, seatManager);

            process = StartSleepProcess();
            var processId = process.Id;
            var session = new NosebleedSession(
                $"games-vault-5-6-{Guid.NewGuid():N}",
                5,
                6,
                18125,
                "http://127.0.0.1:18125",
                null,
                DateTimeOffset.UtcNow,
                "/tmp/fake-core.so",
                "/tmp/fake-content.rom");
            SeedManagedSession(sessionManager, "test-shutdown", session, process);
            seatManager.Assign(session.Id, "viewer-1", DateTimeOffset.UtcNow);

            await sessionManager.ShutdownAsync();

            Assert.False(Directory.Exists($"/proc/{processId}"));
            Assert.Empty(sessionManager.GetSessions());
            Assert.Empty(seatManager.GetAssignments(session.Id, DateTimeOffset.UtcNow.AddSeconds(1)));
        }
        finally
        {
            sessionManager?.Dispose();
            TryKill(process);
            DeleteDirectory(tempRoot);
        }
    }

    private static NosebleedSessionManager CreateSessionManager(
        AppDbContext db,
        IOptions<NosebleedOptions> options,
        NosebleedProcessInspector processInspector,
        NosebleedSeatManager seatManager)
    {
        var services = new ServiceCollection();
        services.AddSingleton(db);
        var serviceProvider = services.BuildServiceProvider();

        return new NosebleedSessionManager(
            options,
            serviceProvider.GetRequiredService<IServiceScopeFactory>(),
            new NosebleedTicketSigner(options, NullLogger<NosebleedTicketSigner>.Instance),
            new NoopHttpClientFactory(),
            new SystemCoreMappingResolver(options),
            processInspector,
            seatManager,
            NullLogger<NosebleedSessionManager>.Instance);
    }

    private static IOptions<NosebleedOptions> CreateOptions(string tempRoot)
    {
        var binaryPath = Path.Combine(tempRoot, "fake-nosebleed.sh");
        File.WriteAllText(binaryPath, "#!/usr/bin/env bash\ntrap 'exit 0' TERM INT\nwhile true; do sleep 5; done\n", new UTF8Encoding(encoderShouldEmitUTF8Identifier: false));
        var chmod = Process.Start(new ProcessStartInfo("chmod", $"+x \"{binaryPath}\"")
        {
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true
        });
        chmod!.WaitForExit();

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
        return Process.Start(new ProcessStartInfo
        {
            FileName = binaryPath,
            UseShellExecute = false,
            RedirectStandardOutput = false,
            RedirectStandardError = false,
            ArgumentList =
            {
                "--listen", $"0.0.0.0:{port}",
                "--core", corePath,
                "--content", contentPath,
                "--session-id", sessionId
            }
        })!;
    }

    private static Process StartSleepProcess()
    {
        return Process.Start(new ProcessStartInfo
        {
            FileName = "/bin/sh",
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            ArgumentList = { "-lc", "sleep 300" }
        })!;
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
        var path = Path.Combine(Path.GetTempPath(), $"gv-reconcile-{Guid.NewGuid():N}");
        Directory.CreateDirectory(path);
        return path;
    }

    private static void DeleteDirectory(string path)
    {
        try
        {
            if (Directory.Exists(path))
            {
                Directory.Delete(path, recursive: true);
            }
        }
        catch
        {
        }
    }

    private static void TryKill(Process? process)
    {
        if (process is null)
        {
            return;
        }

        try
        {
            if (!process.HasExited)
            {
                process.Kill(entireProcessTree: true);
                process.WaitForExit(5000);
            }
        }
        catch
        {
        }
        finally
        {
            process.Dispose();
        }
    }

    private sealed class NoopHttpClientFactory : IHttpClientFactory
    {
        public HttpClient CreateClient(string name) => new();
    }
}
