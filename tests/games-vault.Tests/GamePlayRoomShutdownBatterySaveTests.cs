using System.Diagnostics;
using Microsoft.Extensions.Caching.Memory;
using System.Reflection;
using games_vault.Data;
using games_vault.Gameplay;
using games_vault.Libretro.Import;
using games_vault.Models;
using games_vault.Nosebleed;
using games_vault.Profiles;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.FileProviders;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;

namespace games_vault.Tests;

public sealed class GamePlayRoomShutdownBatterySaveTests
{
    [Fact]
    public async Task DisconnectRoomParticipantSessionAsync_persists_runtime_save_before_stopping_session()
    {
        await using var fixture = await CreateFixtureAsync();
        var runtimeDir = fixture.RuntimeSyncService.GetRuntimeSaveDirectory(fixture.Session.Id);
        Directory.CreateDirectory(runtimeDir);
        await File.WriteAllBytesAsync(Path.Combine(runtimeDir, "sonic.srm"), new byte[] { 4, 3, 2, 1 });

        await fixture.RoomService.DisconnectRoomParticipantSessionAsync(fixture.Session.Id, fixture.ViewerId, CancellationToken.None);

        var room = await fixture.Db.GamePlayRooms.AsNoTracking().SingleAsync(x => x.Id == fixture.Room.Id);
        var latest = await fixture.BatterySaveService.GetLatestRevisionAsync(fixture.Profile.Id, fixture.Game.Id, fixture.File.Id, null, "default", "sonic.srm", CancellationToken.None);

        Assert.Equal(GamePlayRoomStatus.Closed, room.Status);
        Assert.NotNull(latest);
        Assert.Equal("runtime", latest!.Source);
        Assert.Empty(fixture.SessionManager.GetSessions());
    }

    [Fact]
    public async Task DisconnectRoomParticipantSessionAsync_ties_runtime_capture_to_active_player_profile_not_room_creator()
    {
        await using var fixture = await CreateFixtureAsync();

        var activeProfile = new UserProfile
        {
            DisplayName = "Player Two",
            Username = "player-two",
            PasskeyUserHandleBase64Url = "handle-player-two",
            CreatedUtc = DateTime.UtcNow,
            UpdatedUtc = DateTime.UtcNow
        };
        fixture.Db.UserProfiles.Add(activeProfile);
        await fixture.Db.SaveChangesAsync();

        var participant = await fixture.Db.GamePlayRoomParticipants.SingleAsync(x => x.RoomId == fixture.Room.Id && x.ViewerId == fixture.ViewerId);
        participant.ProfileId = activeProfile.Id;
        participant.DisplayNameSnapshot = activeProfile.DisplayName;
        await fixture.Db.SaveChangesAsync();

        fixture.HttpContextAccessor.HttpContext!.Request.Headers.Cookie = $"{CurrentProfileService.CookieName}={activeProfile.Id}";

        var runtimeDir = fixture.RuntimeSyncService.GetRuntimeSaveDirectory(fixture.Session.Id);
        Directory.CreateDirectory(runtimeDir);
        await File.WriteAllBytesAsync(Path.Combine(runtimeDir, "sonic.srm"), new byte[] { 7, 7, 7, 7 });

        await fixture.RoomService.DisconnectRoomParticipantSessionAsync(fixture.Session.Id, fixture.ViewerId, CancellationToken.None);

        var creatorLatest = await fixture.BatterySaveService.GetLatestRevisionAsync(fixture.Profile.Id, fixture.Game.Id, fixture.File.Id, null, "default", "sonic.srm", CancellationToken.None);
        var activeLatest = await fixture.BatterySaveService.GetLatestRevisionAsync(activeProfile.Id, fixture.Game.Id, fixture.File.Id, null, "default", "sonic.srm", CancellationToken.None);

        Assert.Null(creatorLatest);
        Assert.NotNull(activeLatest);
        Assert.Equal("runtime", activeLatest!.Source);
    }

    [Fact]
    public async Task FlushStandaloneRoomBatterySaveAsync_persists_runtime_save_without_stopping_session()
    {
        await using var fixture = await CreateFixtureAsync();
        var runtimeDir = fixture.RuntimeSyncService.GetRuntimeSaveDirectory(fixture.Session.Id);
        Directory.CreateDirectory(runtimeDir);
        await File.WriteAllBytesAsync(Path.Combine(runtimeDir, "sonic.srm"), new byte[] { 1, 4, 1, 4 });

        var result = await fixture.RoomService.FlushStandaloneRoomBatterySaveAsync(fixture.Room.Id, CancellationToken.None);

        var latest = await fixture.BatterySaveService.GetLatestRevisionAsync(fixture.Profile.Id, fixture.Game.Id, fixture.File.Id, null, "default", "sonic.srm", CancellationToken.None);

        Assert.True(result.Success);
        Assert.Equal(1, result.CapturedCount);
        Assert.NotNull(latest);
        Assert.Equal("runtime", latest!.Source);
        Assert.Equal(GamePlayRoomStatus.Active, (await fixture.Db.GamePlayRooms.AsNoTracking().SingleAsync(x => x.Id == fixture.Room.Id)).Status);
    }

    [Fact]
    public async Task LeaveServerSession_awaits_disconnect_and_captures_runtime_save()
    {
        await using var fixture = await CreateFixtureAsync();
        var runtimeDir = fixture.RuntimeSyncService.GetRuntimeSaveDirectory(fixture.Session.Id);
        Directory.CreateDirectory(runtimeDir);
        await File.WriteAllBytesAsync(Path.Combine(runtimeDir, "sonic.srm"), new byte[] { 9, 8, 7, 6 });

        var httpContext = new DefaultHttpContext();
        httpContext.Request.Headers.Cookie = $"games_vault_nosebleed_viewer={fixture.ViewerId}";
        var accessor = new HttpContextAccessor { HttpContext = httpContext };

        var services = new ServiceCollection();
        services.AddSingleton(fixture.SeatManager);
        services.AddSingleton(fixture.RoomService);
        services.AddSingleton<Microsoft.AspNetCore.Mvc.Routing.IUrlHelperFactory>(new Microsoft.AspNetCore.Mvc.Routing.UrlHelperFactory());
        var sp = services.BuildServiceProvider();
        httpContext.RequestServices = sp;

        var controller = new games_vault.Controllers.SessionController(
            fixture.Db)
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = httpContext,
                RouteData = new Microsoft.AspNetCore.Routing.RouteData(),
                ActionDescriptor = new Microsoft.AspNetCore.Mvc.Controllers.ControllerActionDescriptor()
            }
        };

        var result = await controller.LeaveServerSession(fixture.Session.Id);

        Assert.IsType<RedirectToActionResult>(result);
        var room = await fixture.Db.GamePlayRooms.AsNoTracking().SingleAsync(x => x.Id == fixture.Room.Id);
        var latest = await fixture.BatterySaveService.GetLatestRevisionAsync(fixture.Profile.Id, fixture.Game.Id, fixture.File.Id, null, "default", "sonic.srm", CancellationToken.None);

        Assert.Equal(GamePlayRoomStatus.Closed, room.Status);
        Assert.NotNull(latest);
        Assert.Equal("runtime", latest!.Source);
        Assert.Empty(fixture.SessionManager.GetSessions());
    }

    private static async Task<TestFixture> CreateFixtureAsync()
    {
        var scope = await TestDbFixture.CreateScopeAsync();
        var db = scope.Db;

        var profile = new UserProfile
        {
            DisplayName = "Joel",
            Username = "joel",
            PasskeyUserHandleBase64Url = "handle-joel",
            CreatedUtc = DateTime.UtcNow,
            UpdatedUtc = DateTime.UtcNow
        };
        db.UserProfiles.Add(profile);

        var game = new Game
        {
            Name = "Sonic",
            SystemName = "Sega - Mega Drive - Genesis",
            SizeBytes = 1,
            CreatedUtc = DateTime.UtcNow
        };
        db.Games.Add(game);
        await db.SaveChangesAsync();

        var file = new GameFile
        {
            GameId = game.Id,
            Name = "sonic.bin",
            SizeBytes = 1,
            StoragePath = "roms/sonic.bin"
        };
        db.GameFiles.Add(file);
        await db.SaveChangesAsync();

        var room = new GamePlayRoom
        {
            Code = "ABCD",
            GameId = game.Id,
            GameFileId = file.Id,
            CreatedByProfileId = profile.Id,
            Status = GamePlayRoomStatus.Active,
            CreatedUtc = DateTime.UtcNow,
            LastActiveUtc = DateTime.UtcNow,
            NosebleedSessionId = "games-vault-shutdown-test"
        };
        db.GamePlayRooms.Add(room);
        await db.SaveChangesAsync();

        const string viewerId = "viewer-1";
        db.GamePlayRoomParticipants.Add(new GamePlayRoomParticipant
        {
            RoomId = room.Id,
            ViewerId = viewerId,
            ProfileId = profile.Id,
            DisplayNameSnapshot = profile.DisplayName,
            Role = GamePlayRoomParticipantRole.Player,
            Port = 1,
            IsConnected = true,
            JoinedUtc = DateTime.UtcNow,
            LastSeenUtc = DateTime.UtcNow
        });
        await db.SaveChangesAsync();

        var tempRoot = Path.Combine(Path.GetTempPath(), $"room-shutdown-battery-save-{Guid.NewGuid():N}");
        Directory.CreateDirectory(tempRoot);
        var env = new FakeEnvironment(tempRoot);
        var storage = new ProfileGameSaveStorage(env, Options.Create(new LibraryStorageOptions
        {
            RootPath = Path.Combine(tempRoot, "library"),
            ProfileSaveRootPath = Path.Combine(tempRoot, "profile-saves")
        }));
        var batterySaveService = new ProfileBatterySaveService(db, storage);
        var runtimeSyncService = new BatterySaveRuntimeSyncService(
            batterySaveService,
            storage,
            Options.Create(new NosebleedOptions
            {
                SessionRoot = Path.Combine(tempRoot, "nosebleed-sessions")
            }),
            NullLogger<BatterySaveRuntimeSyncService>.Instance);

        var httpContext = new DefaultHttpContext();
        httpContext.Request.Headers.Cookie = $"{CurrentProfileService.CookieName}={profile.Id}";
        var accessor = new TestHttpContextAccessor(httpContext);
        var currentProfile = new CurrentProfileService(db, accessor);
        var currentAccess = new CurrentAccessService(currentProfile, new ConfigurationBuilder().Build(), accessor, db, new EphemeralDataProtectionProvider(), NullLogger<CurrentAccessService>.Instance);

        var nosebleedOptions = Options.Create(new NosebleedOptions
        {
            Enabled = true,
            RequireAuth = false,
            SessionRoot = Path.Combine(tempRoot, "nosebleed-sessions"),
            AuthSecretPath = Path.Combine(tempRoot, "nosebleed.secret")
        });
        var ticketSigner = new NosebleedTicketSigner(nosebleedOptions, NullLogger<NosebleedTicketSigner>.Instance);
        var processInspector = new NosebleedProcessInspector(nosebleedOptions);
        var seatManager = new NosebleedSeatManager(nosebleedOptions);
        var sessionManager = new NosebleedSessionManager(
            nosebleedOptions,
            new TestServiceScopeFactory(),
            ticketSigner,
            new TestHttpClientFactory(),
            new SystemCoreMappingResolver(nosebleedOptions),
            processInspector,
            seatManager,
            NullLogger<NosebleedSessionManager>.Instance);
        var session = new NosebleedSession(
            room.NosebleedSessionId!,
            game.Id,
            file.Id,
            18123,
            "http://127.0.0.1:18123",
            null,
            null,
            DateTimeOffset.UtcNow,
            "/tmp/fake-core.so",
            "/tmp/fake-content.rom");
        var process = StartLongRunningProcess();
        SeedSession(sessionManager, session, process);

        var roomService = new GamePlayRoomService(
            db,
            new RoomCodeGenerator(),
            sessionManager,
            seatManager,
            ticketSigner,
            currentAccess,
            currentProfile,
            new ProfileShareLinkService(db, new LocalProfileService(db, currentProfile), new MemoryCache(new MemoryCacheOptions())),
            new BatterySavePolicyResolver(),
            runtimeSyncService);

        return new TestFixture(scope, db, roomService, sessionManager, seatManager, batterySaveService, runtimeSyncService, profile, game, file, room, session, process, viewerId, accessor, tempRoot);
    }

    private static Process StartLongRunningProcess()
    {
        var process = new Process
        {
            StartInfo = new ProcessStartInfo
            {
                FileName = "/bin/sh",
                ArgumentList = { "-lc", "sleep 300" },
                UseShellExecute = false,
                RedirectStandardOutput = true,
                RedirectStandardError = true
            }
        };

        if (!process.Start())
        {
            throw new InvalidOperationException("Failed to start test session process.");
        }

        return process;
    }

    private static void SeedSession(NosebleedSessionManager manager, NosebleedSession session, Process process)
    {
        var field = typeof(NosebleedSessionManager).GetField("_sessions", BindingFlags.Instance | BindingFlags.NonPublic)
            ?? throw new InvalidOperationException("Could not find NosebleedSessionManager._sessions field.");
        var dictionary = field.GetValue(manager)
            ?? throw new InvalidOperationException("Could not read NosebleedSessionManager._sessions value.");

        var managedSessionType = typeof(NosebleedSessionManager).GetNestedType("ManagedSession", BindingFlags.NonPublic)
            ?? throw new InvalidOperationException("Could not find ManagedSession nested type.");
        var managedSession = Activator.CreateInstance(managedSessionType, session, process)
            ?? throw new InvalidOperationException("Could not construct ManagedSession.");

        var tryAdd = dictionary.GetType().GetMethod("TryAdd")
            ?? throw new InvalidOperationException("Could not find ConcurrentDictionary.TryAdd.");
        var added = (bool)(tryAdd.Invoke(dictionary, new object[] { session.Id, managedSession }) ?? false);
        if (!added)
        {
            throw new InvalidOperationException("Failed to seed active Nosebleed session into manager.");
        }
    }

    private sealed record TestFixture(
        TestDbFixture.Scope Scope,
        AppDbContext Db,
        GamePlayRoomService RoomService,
        NosebleedSessionManager SessionManager,
        NosebleedSeatManager SeatManager,
        ProfileBatterySaveService BatterySaveService,
        BatterySaveRuntimeSyncService RuntimeSyncService,
        UserProfile Profile,
        Game Game,
        GameFile File,
        GamePlayRoom Room,
        NosebleedSession Session,
        Process Process,
        string ViewerId,
        TestHttpContextAccessor HttpContextAccessor,
        string TempRoot) : IAsyncDisposable
    {
        public async ValueTask DisposeAsync()
        {
            SessionManager.Dispose();
            try
            {
                if (!Process.HasExited)
                {
                    Process.Kill(entireProcessTree: true);
                    await Process.WaitForExitAsync();
                }
            }
            catch (InvalidOperationException)
            {
            }

            await Scope.DisposeAsync();
            try
            {
                if (Directory.Exists(TempRoot))
                {
                    Directory.Delete(TempRoot, recursive: true);
                }
            }
            catch
            {
            }
        }
    }

    private sealed class TestHttpContextAccessor(HttpContext httpContext) : IHttpContextAccessor
    {
        public HttpContext? HttpContext { get; set; } = httpContext;
    }

    private sealed class FakeEnvironment(string contentRootPath) : IWebHostEnvironment
    {
        public string EnvironmentName { get; set; } = "Testing";
        public string ApplicationName { get; set; } = "games-vault.Tests";
        public string WebRootPath { get; set; } = contentRootPath;
        public IFileProvider WebRootFileProvider { get; set; } = new NullFileProvider();
        public string ContentRootPath { get; set; } = contentRootPath;
        public IFileProvider ContentRootFileProvider { get; set; } = new NullFileProvider();
    }

    private sealed class TestHttpClientFactory : IHttpClientFactory
    {
        public HttpClient CreateClient(string name) => new();
    }

    private sealed class TestServiceScopeFactory : IServiceScopeFactory
    {
        public IServiceScope CreateScope() => new TestServiceScope();
    }

    private sealed class TestServiceScope : IServiceScope
    {
        public IServiceProvider ServiceProvider { get; } = new Microsoft.Extensions.DependencyInjection.ServiceCollection().BuildServiceProvider();
        public void Dispose()
        {
        }
    }
}
