using System.Collections.Concurrent;
using System.Diagnostics;
using System.Reflection;
using System.Text.Json;
using games_vault.BackgroundJobs;
using games_vault.Controllers;
using games_vault.Data;
using games_vault.Gameplay;
using games_vault.Models;
using games_vault.Nosebleed;
using games_vault.Profiles;
using games_vault.Web;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.ViewFeatures;
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.FileProviders;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;

namespace games_vault.Tests;

public sealed class SpectatorAccessTests
{
    [Fact]
    public void Assign_WithAllowPlayerFalse_KeepsViewerAsSpectatorEvenWhenSeatIsOpen()
    {
        var manager = new NosebleedSeatManager(Options.Create(new NosebleedOptions
        {
            MaxPlayersPerSession = 2,
            SeatTtlMinutes = 30
        }));

        var seat = manager.Assign("session-1", "viewer-1", DateTimeOffset.UtcNow, allowPlayer: false);

        Assert.Equal(NosebleedSeatKind.Spectator, seat.Kind);
        Assert.Null(seat.Port);
        Assert.Null(seat.PlayerNumber);
    }

    [Fact]
    public async Task JoinByCodeAsync_ReturnsSpectatorForViewerEvenWhenPlayerSeatIsOpen()
    {
        await using var fixture = await SpectatorFixture.CreateAsync();
        var roomService = fixture.CreateRoomService();

        var result = await roomService.JoinByCodeAsync(fixture.Room.Code, fixture.ViewerId, CancellationToken.None);

        Assert.True(result.Success);
        Assert.NotNull(result.Seat);
        Assert.Equal(NosebleedSeatKind.Spectator, result.Seat!.Kind);
        Assert.Null(result.Seat.Port);
        Assert.NotNull(result.Room);

        var participant = await fixture.Db.GamePlayRoomParticipants.SingleAsync(x => x.RoomId == fixture.Room.Id && x.ViewerId == fixture.ViewerId);
        Assert.Equal(GamePlayRoomParticipantRole.Spectator, participant.Role);
        Assert.Null(participant.Port);
    }

    [Fact]
    public async Task KeepAliveServerSession_DoesNotPromoteViewerToPlayer()
    {
        await using var fixture = await SpectatorFixture.CreateAsync();
        var controller = fixture.CreateGamesController();

        var result = await controller.KeepAliveServerSession(fixture.Session.Id, CancellationToken.None);

        var json = Assert.IsType<JsonResult>(result);
        using var doc = JsonDocument.Parse(JsonSerializer.Serialize(json.Value));
        Assert.Equal("spectator", doc.RootElement.GetProperty("kind").GetString());
        Assert.Equal(JsonValueKind.Null, doc.RootElement.GetProperty("port").ValueKind);
        Assert.Equal(JsonValueKind.Null, doc.RootElement.GetProperty("playerNumber").ValueKind);
    }

    private sealed class SpectatorFixture : IAsyncDisposable
    {
        private readonly SqliteConnection _connection;
        private readonly Process _sessionProcess;
        private readonly IHttpContextAccessor _httpContextAccessor;
        private readonly IConfiguration _configuration;
        private readonly IOptions<NosebleedOptions> _nosebleedOptions;
        private readonly NosebleedTicketSigner _ticketSigner;

        private SpectatorFixture(
            SqliteConnection connection,
            AppDbContext db,
            Game game,
            GameFile file,
            GamePlayRoom room,
            NosebleedSession session,
            Process sessionProcess,
            string viewerId,
            IHttpContextAccessor httpContextAccessor,
            IConfiguration configuration,
            IOptions<NosebleedOptions> nosebleedOptions,
            NosebleedTicketSigner ticketSigner,
            NosebleedSessionManager sessionManager,
            NosebleedSeatManager seatManager)
        {
            _connection = connection;
            Db = db;
            Game = game;
            File = file;
            Room = room;
            Session = session;
            _sessionProcess = sessionProcess;
            ViewerId = viewerId;
            _httpContextAccessor = httpContextAccessor;
            _configuration = configuration;
            _nosebleedOptions = nosebleedOptions;
            _ticketSigner = ticketSigner;
            SessionManager = sessionManager;
            SeatManager = seatManager;
        }

        public AppDbContext Db { get; }
        public Game Game { get; }
        public GameFile File { get; }
        public GamePlayRoom Room { get; }
        public NosebleedSession Session { get; }
        public string ViewerId { get; }
        public NosebleedSessionManager SessionManager { get; }
        public NosebleedSeatManager SeatManager { get; }

        public static async Task<SpectatorFixture> CreateAsync()
        {
            var connection = new SqliteConnection("Data Source=:memory:");
            await connection.OpenAsync();
            var options = new DbContextOptionsBuilder<AppDbContext>()
                .UseSqlite(connection)
                .Options;
            var db = new AppDbContext(options);
            await db.Database.EnsureCreatedAsync();

            var game = new Game { Name = "Viewer Test Game", SystemName = "Sega - Mega Drive - Genesis", SizeBytes = 1 };
            var file = new GameFile { Game = game, Name = "viewer-test.bin", SizeBytes = 1, ExternalPath = "/tmp/viewer-test.bin" };
            db.Games.Add(game);
            db.GameFiles.Add(file);
            await db.SaveChangesAsync();

            var room = new GamePlayRoom
            {
                Code = "ABCD",
                GameId = game.Id,
                GameFileId = file.Id,
                Status = GamePlayRoomStatus.Active,
                CreatedUtc = DateTime.UtcNow,
                LastActiveUtc = DateTime.UtcNow,
                NosebleedSessionId = "games-vault-test-session"
            };
            db.GamePlayRooms.Add(room);
            await db.SaveChangesAsync();

            var httpContext = new DefaultHttpContext();
            var viewerId = Guid.NewGuid().ToString("N");
            httpContext.Request.Headers.Cookie = $"games_vault_nosebleed_viewer={viewerId}";
            var accessor = new TestHttpContextAccessor(httpContext);
            var configuration = new ConfigurationBuilder()
                .AddInMemoryCollection(new Dictionary<string, string?>
                {
                    ["Access:AdminAlways"] = "false"
                })
                .Build();

            var secretPath = Path.Combine(Path.GetTempPath(), $"nosebleed-test-{Guid.NewGuid():N}.secret");
            var nosebleedOptions = Options.Create(new NosebleedOptions
            {
                Enabled = true,
                RequireAuth = true,
                AuthSecretPath = secretPath,
                MaxPlayersPerSession = 2,
                SeatTtlMinutes = 30
            });
            var ticketSigner = new NosebleedTicketSigner(nosebleedOptions, NullLogger<NosebleedTicketSigner>.Instance);
            var sessionManager = new NosebleedSessionManager(
                nosebleedOptions,
                new TestServiceScopeFactory(),
                ticketSigner,
                new TestHttpClientFactory(),
                NullLogger<NosebleedSessionManager>.Instance);
            var seatManager = new NosebleedSeatManager(nosebleedOptions);

            var process = StartLongRunningProcess();
            var session = new NosebleedSession(
                room.NosebleedSessionId!,
                game.Id,
                file.Id,
                18123,
                "http://127.0.0.1:18123",
                null,
                DateTimeOffset.UtcNow,
                "/tmp/fake-core.so",
                "/tmp/fake-content.rom");
            SeedSession(sessionManager, session, process);

            var fixture = new SpectatorFixture(
                connection,
                db,
                game,
                file,
                room,
                session,
                process,
                viewerId,
                accessor,
                configuration,
                nosebleedOptions,
                ticketSigner,
                sessionManager,
                seatManager);

            return fixture;
        }

        public GamePlayRoomService CreateRoomService()
        {
            var currentProfile = new CurrentProfileService(Db, _httpContextAccessor);
            var currentAccess = new CurrentAccessService(currentProfile, _configuration, _httpContextAccessor);
            return new GamePlayRoomService(
                Db,
                new RoomCodeGenerator(),
                SessionManager,
                SeatManager,
                _ticketSigner,
                currentAccess,
                currentProfile);
        }

        public GamesController CreateGamesController()
        {
            var currentProfile = new CurrentProfileService(Db, _httpContextAccessor);
            var currentAccess = new CurrentAccessService(currentProfile, _configuration, _httpContextAccessor);
            var roomService = CreateRoomService();

            var controller = new GamesController(
                Db,
                null!,
                null!,
                null!,
                null!,
                null!,
                null!,
                null!,
                new FakeEnvironment(Path.GetTempPath()),
                Options.Create(new WebPlayerOptions()),
                _nosebleedOptions,
                SessionManager,
                SeatManager,
                _ticketSigner,
                null!,
                new GamePlayTelemetryService(Db),
                roomService,
                currentProfile,
                currentAccess,
                new TestHttpClientFactory())
            {
                ControllerContext = new ControllerContext { HttpContext = _httpContextAccessor.HttpContext! },
                TempData = new TempDataDictionary(_httpContextAccessor.HttpContext!, new TestTempDataProvider())
            };

            return controller;
        }

        public async ValueTask DisposeAsync()
        {
            SessionManager.Dispose();
            try
            {
                if (!_sessionProcess.HasExited)
                {
                    _sessionProcess.Kill(entireProcessTree: true);
                    await _sessionProcess.WaitForExitAsync();
                }
            }
            catch (InvalidOperationException)
            {
                // SessionManager.Dispose() already tore down the seeded process.
            }

            await Db.DisposeAsync();
            await _connection.DisposeAsync();
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

    private sealed class TestTempDataProvider : ITempDataProvider
    {
        public IDictionary<string, object> LoadTempData(HttpContext context) => new Dictionary<string, object>();

        public void SaveTempData(HttpContext context, IDictionary<string, object> values)
        {
        }
    }
}
