using games_vault.Arcade;
using games_vault.Controllers;
using games_vault.Data;
using games_vault.Gameplay;
using games_vault.Libretro.Import;
using games_vault.Models;
using games_vault.Models.ViewModels;
using games_vault.Nosebleed;
using games_vault.Profiles;
using System.Diagnostics;
using System.Reflection;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.Abstractions;
using Microsoft.AspNetCore.Mvc.Routing;
using Microsoft.AspNetCore.Mvc.ViewFeatures;
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.FileProviders;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;

namespace games_vault.Tests;

public sealed class ArcadeControllerTests
{
    [Fact]
    public async Task Join_UnlaunchedCabinetReturnsServerPlayerViewInsteadOfNotFound()
    {
        await using var fixture = await CreateFixtureAsync(adminAlways: false);
        fixture.Cabinet.RuntimeSessionId = null;
        fixture.Cabinet.LastError = null;
        await fixture.Db.SaveChangesAsync();

        var controller = fixture.CreateController();

        var result = await controller.Join(fixture.Cabinet.Id, CancellationToken.None);

        var view = Assert.IsType<ViewResult>(result);
        Assert.Equal("~/Views/Games/PlayServer.cshtml", view.ViewName);
        var model = Assert.IsType<ServerGamePlayViewModel>(view.Model);
        Assert.Equal(fixture.Cabinet.GameId, model.Game.Id);
        Assert.NotNull(model.File);
        Assert.Equal(fixture.Cabinet.GameFileId, model.File!.Id);
        Assert.False(string.IsNullOrWhiteSpace(model.Error));
    }

    [Fact]
    public async Task Join_RunningCabinetRedirectsToCanonicalSessionGuidRoute()
    {
        await using var fixture = await CreateFixtureAsync(adminAlways: false);
        var session = new NosebleedSession(
            "games-vault-1-1-1234567890abcdef1234567890abcdef",
            fixture.Cabinet.GameId,
            fixture.Cabinet.GameFileId!.Value,
            8099,
            "http://vault:8099",
            "",
            DateTimeOffset.UtcNow.AddMinutes(-5),
            "/cores/fbneo_libretro.so",
            "/roms/metalslug.zip");
        fixture.Cabinet.RuntimeSessionId = session.Id;
        await fixture.Db.SaveChangesAsync();
        SeedManagedSession(fixture.SessionManager, $"arcade-cabinet:{fixture.Cabinet.Id}", session);

        var controller = fixture.CreateController();

        var result = await controller.Join(fixture.Cabinet.Id, CancellationToken.None);

        var redirect = Assert.IsType<RedirectToRouteResult>(result);
        Assert.Equal("ArcadeSession", redirect.RouteName);
        Assert.NotNull(redirect.RouteValues);
        Assert.Equal(session.Id, redirect.RouteValues!["sessionId"]);
    }

    [Fact]
    public async Task OpenSession_RunningCabinetReturnsPlayerViewUsingSessionGuid()
    {
        await using var fixture = await CreateFixtureAsync(adminAlways: false);
        var session = new NosebleedSession(
            "games-vault-1-1-fedcba0987654321fedcba0987654321",
            fixture.Cabinet.GameId,
            fixture.Cabinet.GameFileId!.Value,
            8100,
            "http://vault:8100",
            "",
            DateTimeOffset.UtcNow.AddMinutes(-3),
            "/cores/fbneo_libretro.so",
            "/roms/metalslug.zip");
        fixture.Cabinet.RuntimeSessionId = session.Id;
        await fixture.Db.SaveChangesAsync();
        SeedManagedSession(fixture.SessionManager, $"arcade-cabinet:{fixture.Cabinet.Id}", session);

        var controller = fixture.CreateController();

        var result = await controller.OpenSession(session.Id, CancellationToken.None);

        var view = Assert.IsType<ViewResult>(result);
        Assert.Equal("~/Views/Games/PlayServer.cshtml", view.ViewName);
        var model = Assert.IsType<ServerGamePlayViewModel>(view.Model);
        Assert.Equal(session.Id, model.SessionId);
        Assert.Equal("http://vault:8100", model.BaseUrl);
        Assert.Null(model.CurrentRoomCode);
        Assert.False(model.ShowRoomControls);
        Assert.Equal("/Arcade", model.LeaveSessionReturnUrl);
    }

    [Fact]
    public async Task OpenSession_UnknownRuntimeSessionIdReturnsNotFound()
    {
        await using var fixture = await CreateFixtureAsync(adminAlways: false);
        var controller = fixture.CreateController();

        var result = await controller.OpenSession("games-vault-1-1-missing", CancellationToken.None);

        Assert.IsType<NotFoundResult>(result);
    }

    [Fact]
    public async Task RemoveCabinet_RemovesCabinetAndRedirectsToIndex()
    {
        await using var fixture = await CreateFixtureAsync(adminAlways: true);
        var controller = fixture.CreateController();

        var result = await controller.RemoveCabinet(fixture.Cabinet.Id, CancellationToken.None);

        var redirect = Assert.IsType<RedirectToActionResult>(result);
        Assert.Equal(nameof(ArcadeController.Index), redirect.ActionName);
        Assert.False(await fixture.Db.ArcadeCabinets.AnyAsync(x => x.Id == fixture.Cabinet.Id));
    }

    [Fact]
    public async Task RemoveCabinet_ReturnsForbidWhenViewerCannotManageArcade()
    {
        await using var fixture = await CreateFixtureAsync(adminAlways: false);
        var controller = fixture.CreateController();

        var result = await controller.RemoveCabinet(fixture.Cabinet.Id, CancellationToken.None);

        Assert.IsType<ForbidResult>(result);
        Assert.True(await fixture.Db.ArcadeCabinets.AnyAsync(x => x.Id == fixture.Cabinet.Id));
    }

    private static async Task<TestFixture> CreateFixtureAsync(bool adminAlways)
    {
        var connection = new SqliteConnection("Data Source=:memory:");
        await connection.OpenAsync();
        var options = new DbContextOptionsBuilder<AppDbContext>()
            .UseSqlite(connection)
            .Options;
        var db = new AppDbContext(options);
        await db.Database.EnsureCreatedAsync();

        var arcade = new games_vault.Models.Arcade { Name = "Arcade", Slug = "arcade", IsEnabled = true };
        var game = new Game { Name = "Metal Slug", SystemName = "arcade", SizeBytes = 1 };
        var file = new GameFile { Game = game, Name = "metalslug.zip", SizeBytes = 1, ExternalPath = "/tmp/metalslug.zip" };
        var cabinet = new ArcadeCabinet
        {
            Arcade = arcade,
            Game = game,
            GameFile = file,
            DisplayName = "Metal Slug Cabinet",
            SortOrder = 10,
            IsEnabled = true,
            AutoRestart = true
        };

        db.Arcades.Add(arcade);
        db.Games.Add(game);
        db.GameFiles.Add(file);
        db.ArcadeCabinets.Add(cabinet);
        await db.SaveChangesAsync();

        var httpContext = new DefaultHttpContext();
        var accessor = new TestHttpContextAccessor(httpContext);
        var config = new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["Access:AdminAlways"] = adminAlways ? "true" : "false"
            })
            .Build();
        var nosebleedOptions = Options.Create(new NosebleedOptions
        {
            Enabled = false,
            RequireAuth = false,
            AuthSecretPath = Path.Combine(Path.GetTempPath(), $"nosebleed-test-{Guid.NewGuid():N}.secret")
        });
        var sessionManager = new NosebleedSessionManager(
            nosebleedOptions,
            new TestServiceScopeFactory(),
            new NosebleedTicketSigner(nosebleedOptions, NullLogger<NosebleedTicketSigner>.Instance),
            new TestHttpClientFactory(),
            NullLogger<NosebleedSessionManager>.Instance);

        return new TestFixture(connection, db, cabinet, accessor, config, nosebleedOptions, sessionManager);
    }

    private sealed class TestHttpContextAccessor(HttpContext httpContext) : IHttpContextAccessor
    {
        public HttpContext? HttpContext { get; set; } = httpContext;
    }

    private sealed record TestFixture(
        SqliteConnection Connection,
        AppDbContext Db,
        ArcadeCabinet Cabinet,
        IHttpContextAccessor HttpContextAccessor,
        IConfiguration Configuration,
        IOptions<NosebleedOptions> NosebleedOptions,
        NosebleedSessionManager SessionManager) : IAsyncDisposable
    {
        public ArcadeController CreateController()
        {
            var env = new FakeEnvironment(Path.GetTempPath());
            var fileStorage = new GameFileStorage(env, Options.Create(new LibraryStorageOptions { RootPath = Path.GetTempPath() }));
            var fileResolver = new ArcadeGameFileResolver(Db, fileStorage);
            var currentProfile = new CurrentProfileService(Db, HttpContextAccessor);
            var currentAccess = new CurrentAccessService(currentProfile, Configuration, HttpContextAccessor);

            return new ArcadeController(
                Db,
                fileResolver,
                SessionManager,
                new NosebleedSeatManager(NosebleedOptions),
                new NosebleedTicketSigner(NosebleedOptions, NullLogger<NosebleedTicketSigner>.Instance),
                new GamePlayTelemetryService(Db),
                currentProfile,
                currentAccess,
                NosebleedOptions)
            {
                ControllerContext = new ControllerContext { HttpContext = HttpContextAccessor.HttpContext! },
                TempData = new TempDataDictionary(HttpContextAccessor.HttpContext!, new TestTempDataProvider()),
                Url = new TestUrlHelper()
            };
        }

        public async ValueTask DisposeAsync()
        {
            await Db.DisposeAsync();
            await Connection.DisposeAsync();
        }
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
        public IServiceProvider ServiceProvider { get; } = new ServiceCollection().BuildServiceProvider();
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

    private sealed class TestUrlHelper : IUrlHelper
    {
        public ActionContext ActionContext { get; } = new(new DefaultHttpContext(), new Microsoft.AspNetCore.Routing.RouteData(), new ActionDescriptor());

        public string? Action(UrlActionContext actionContext)
        {
            if (string.Equals(actionContext.Action, nameof(ArcadeController.Index), StringComparison.OrdinalIgnoreCase)
                && string.Equals(actionContext.Controller, "Arcade", StringComparison.OrdinalIgnoreCase))
            {
                return "/Arcade";
            }

            return null;
        }

        public string? Content(string? contentPath) => contentPath;

        public bool IsLocalUrl(string? url) => true;

        public string? Link(string? routeName, object? values) => null;

        public string? RouteUrl(UrlRouteContext routeContext) => null;
    }

    private static void SeedManagedSession(NosebleedSessionManager manager, string key, NosebleedSession session)
    {
        var sessionsField = typeof(NosebleedSessionManager).GetField("_sessions", BindingFlags.Instance | BindingFlags.NonPublic);
        Assert.NotNull(sessionsField);
        var sessions = sessionsField!.GetValue(manager);
        Assert.NotNull(sessions);

        var managedSessionType = typeof(NosebleedSessionManager).GetNestedType("ManagedSession", BindingFlags.NonPublic);
        Assert.NotNull(managedSessionType);
        var managedSession = System.Runtime.CompilerServices.RuntimeHelpers.GetUninitializedObject(managedSessionType!);
        Assert.NotNull(managedSession);

        var sessionField = managedSessionType!.GetField("<Session>k__BackingField", BindingFlags.Instance | BindingFlags.NonPublic);
        var processField = managedSessionType.GetField("<Process>k__BackingField", BindingFlags.Instance | BindingFlags.NonPublic);
        Assert.NotNull(sessionField);
        Assert.NotNull(processField);
        sessionField!.SetValue(managedSession, session);
        processField!.SetValue(managedSession, Process.GetCurrentProcess());

        var tryAdd = sessions!.GetType().GetMethod("TryAdd");
        Assert.NotNull(tryAdd);
        var added = tryAdd!.Invoke(sessions, [key, managedSession]);
        Assert.True(added is true);
    }
}
