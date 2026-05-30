using games_vault.Arcade;
using games_vault.Controllers;
using games_vault.Data;
using games_vault.Gameplay;
using games_vault.Libretro.Import;
using games_vault.Models;
using games_vault.Nosebleed;
using games_vault.Profiles;
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

public sealed class ArcadeControllerTests
{
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

        return new TestFixture(connection, db, cabinet, accessor, config);
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
        IConfiguration Configuration) : IAsyncDisposable
    {
        public ArcadeController CreateController()
        {
            var env = new FakeEnvironment(Path.GetTempPath());
            var fileStorage = new GameFileStorage(env, Options.Create(new LibraryStorageOptions { RootPath = Path.GetTempPath() }));
            var fileResolver = new ArcadeGameFileResolver(Db, fileStorage);
            var currentProfile = new CurrentProfileService(Db, HttpContextAccessor);
            var currentAccess = new CurrentAccessService(currentProfile, Configuration, HttpContextAccessor);
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

            return new ArcadeController(
                Db,
                fileResolver,
                sessionManager,
                new NosebleedSeatManager(nosebleedOptions),
                new NosebleedTicketSigner(nosebleedOptions, NullLogger<NosebleedTicketSigner>.Instance),
                new GamePlayTelemetryService(Db),
                currentProfile,
                currentAccess,
                nosebleedOptions)
            {
                ControllerContext = new ControllerContext { HttpContext = HttpContextAccessor.HttpContext! },
                TempData = new TempDataDictionary(HttpContextAccessor.HttpContext!, new TestTempDataProvider())
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
        public IFileProvider WebRootFileProvider { get; set; } = new Microsoft.Extensions.FileProviders.NullFileProvider();
        public string ContentRootPath { get; set; } = contentRootPath;
        public IFileProvider ContentRootFileProvider { get; set; } = new Microsoft.Extensions.FileProviders.NullFileProvider();
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
}
