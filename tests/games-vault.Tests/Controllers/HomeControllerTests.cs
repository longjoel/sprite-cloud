using System.Diagnostics;
using System.Reflection;
using games_vault.BackgroundJobs;
using games_vault.Controllers;
using games_vault.Gameplay;
using games_vault.Libretro;
using games_vault.Libretro.Dat;
using games_vault.Libretro.Import;
using games_vault.Models;
using games_vault.Models.ViewModels;
using games_vault.Nosebleed;
using games_vault.Profiles;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.ViewFeatures;
using Microsoft.Extensions.Caching.Memory;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;

namespace games_vault.Tests;

public sealed class HomeControllerTests : GamesVaultTestBase
{
    [Fact]
    public async Task Index_SignedInView_ReturnsProfileCardDataLibraryAndSessions()
    {
        // Arrange
        var profile = new UserProfile
        {
            DisplayName = "TestPlayer",
            Username = "testplayer",
            Color = "#ff6600",
            IsAdmin = false,
            PasskeyUserHandleBase64Url = "fake-handle"
        };
        Db.UserProfiles.Add(profile);
        await Db.SaveChangesAsync();

        var game = new Game
        {
            Name = "Super Mario Bros.",
            SystemName = "Nintendo - NES",
            Genre = "Platformer",
            NumberOfPlayers = 2,
            SizeBytes = 40960,
            CreatedUtc = DateTime.UtcNow
        };
        var session1 = new GamePlaySession
        {
            Game = game,
            Mode = "nosebleed",
            ProfileId = profile.Id,
            Profile = profile,
            StartedUtc = DateTime.UtcNow.AddHours(-1),
            DurationSeconds = 3600
        };
        var session2 = new GamePlaySession
        {
            Game = game,
            Mode = "nosebleed",
            ProfileId = profile.Id,
            Profile = profile,
            StartedUtc = DateTime.UtcNow.AddMinutes(-30),
            DurationSeconds = 1800
        };
        Db.Games.Add(game);
        Db.GamePlaySessions.AddRange(session1, session2);
        await Db.SaveChangesAsync();

        var httpContext = new DefaultHttpContext();
        httpContext.Items["gv.current-profile.id"] = profile.Id;

        var controller = CreateController(httpContext);

        // Act
        var result = await controller.Index(CancellationToken.None);

        // Assert
        var view = Assert.IsType<ViewResult>(result);
        var model = Assert.IsType<HomeIndexViewModel>(view.Model);

        Assert.Equal(profile.Id, model.CurrentProfileId);
        Assert.Equal(profile.DisplayName, model.CurrentProfileName);
        Assert.Equal("Player", model.AccessMode);
        Assert.True(model.CanPlay);
        Assert.False(model.CanManageLibrary);
        Assert.Single(model.LibraryPreviewGames);
        Assert.Equal(game.Name, model.LibraryPreviewGames[0].GameName);
        Assert.Equal(game.SystemName, model.LibraryPreviewGames[0].SystemName);
        Assert.Equal(game.Genre, model.LibraryPreviewGames[0].Genre);
        Assert.Equal(game.Name, model.LastPlayedGame);
        Assert.True(model.PlaySessionCount >= 2);
        Assert.Equal(1, model.GamesCount);
        Assert.True(model.ShowDashboard);
    }

    [Fact]
    public async Task Index_AnonymousView_ReturnsViewerAccessMode()
    {
        // Arrange - no profile, no cookies
        var httpContext = new DefaultHttpContext();
        var controller = CreateController(httpContext);

        // Act
        var result = await controller.Index(CancellationToken.None);

        // Assert
        var view = Assert.IsType<ViewResult>(result);
        var model = Assert.IsType<HomeIndexViewModel>(view.Model);

        Assert.Null(model.CurrentProfileId);
        Assert.Null(model.CurrentProfileName);
        Assert.Equal("Viewer", model.AccessMode);
        Assert.False(model.CanPlay);
        Assert.False(model.CanManageLibrary);
        Assert.Empty(model.ActiveProfiles);
        Assert.Empty(model.LibraryPreviewGames);
        Assert.Empty(model.ActiveNosebleedSessions);
    }

    [Fact]
    public async Task Index_ActiveSessions_ReturnsSessionsInViewModel()
    {
        // Arrange
        var httpContext = new DefaultHttpContext();
        var controller = CreateController(httpContext);

        var game = new Game
        {
            Name = "Metroid",
            SystemName = "Nintendo - NES",
            SizeBytes = 32768
        };
        var file = new GameFile
        {
            Game = game,
            Name = "metroid.nes",
            SizeBytes = 32768
        };
        Db.Games.Add(game);
        Db.GameFiles.Add(file);
        await Db.SaveChangesAsync();

        var session = new NosebleedSession(
            "games-vault-1-1-abcdefabcdefabcdefabcdefabcdefab",
            game.Id,
            file.Id,
            8100,
            "http://vault:8100",
            "",
            DateTimeOffset.UtcNow.AddMinutes(-10),
            "/cores/nestopia_libretro.so",
            "/roms/metroid.nes");

        // Inject session into the session manager using reflection
        InjectManagedSession(controller, "test-key-1", session);

        // Act
        var result = await controller.Index(CancellationToken.None);

        // Assert
        var view = Assert.IsType<ViewResult>(result);
        var model = Assert.IsType<HomeIndexViewModel>(view.Model);

        Assert.NotEmpty(model.ActiveNosebleedSessions);
        Assert.NotEmpty(model.ActiveLibrarySessions);
        Assert.NotNull(model.FeaturedSession);
        Assert.Equal(session.Id, model.FeaturedSession!.SessionId);
        Assert.Equal(game.Id, model.FeaturedSession.GameId);
        Assert.Equal(game.Name, model.FeaturedSession.GameName);
        Assert.Equal(file.Id, model.FeaturedSession.FileId);
        Assert.Equal(session.Port, model.FeaturedSession.Port);
        Assert.Equal(session.BaseUrl, model.FeaturedSession.BaseUrl);
        Assert.False(model.FeaturedSession.IsArcadeCabinet);
        Assert.True(model.ShowDashboard);
    }

    [Fact]
    public async Task Index_EmptyState_PageRendersWithoutExceptions()
    {
        // Arrange - completely empty database
        var httpContext = new DefaultHttpContext();
        var controller = CreateController(httpContext);

        // Act
        var result = await controller.Index(CancellationToken.None);

        // Assert
        var view = Assert.IsType<ViewResult>(result);
        var model = Assert.IsType<HomeIndexViewModel>(view.Model);

        Assert.False(model.ShowDashboard);
        Assert.Equal(0, model.GamesCount);
        Assert.Equal(0, model.SystemsCount);
        Assert.Equal(0, model.GameFilesCount);
        Assert.Equal(0L, model.TotalGameBytes);
        Assert.Equal(0, model.SystemFilesCount);
        Assert.Equal(0, model.NetworkSharesCount);
        Assert.Equal(0, model.LocalFoldersCount);
        Assert.Equal(0, model.WebSourcesCount);
        Assert.Empty(model.LibraryPreviewGames);
        Assert.Empty(model.ActiveNosebleedSessions);
        Assert.Empty(model.ActiveProfiles);
        Assert.Empty(model.RecentSessions);
        Assert.Empty(model.TopPlayedGames);
        Assert.Equal(TimeSpan.Zero, model.TotalPlayTime);
        Assert.Equal(0, model.PlaySessionCount);
        Assert.Equal(TimeSpan.Zero, model.GlobalTotalPlayTime);
        Assert.Equal(0, model.GlobalPlaySessionCount);
        Assert.Null(model.LastPlayedGame);
        Assert.Null(model.LatestLibretroSyncJob);
    }

    [Fact]
    public async Task Index_AdminMode_ReturnsAdminAccessLevel()
    {
        // Arrange
        var adminProfile = new UserProfile
        {
            DisplayName = "AdminUser",
            Username = "admin",
            Color = "#ff0000",
            IsAdmin = true,
            IsEphemeral = false,
            PasskeyUserHandleBase64Url = "fake-admin-handle"
        };
        Db.UserProfiles.Add(adminProfile);
        await Db.SaveChangesAsync();

        var httpContext = new DefaultHttpContext();
        httpContext.Items["gv.current-profile.id"] = adminProfile.Id;

        var controller = CreateController(httpContext);

        // Act
        var result = await controller.Index(CancellationToken.None);

        // Assert
        var view = Assert.IsType<ViewResult>(result);
        var model = Assert.IsType<HomeIndexViewModel>(view.Model);

        Assert.Equal(adminProfile.Id, model.CurrentProfileId);
        Assert.Equal(adminProfile.DisplayName, model.CurrentProfileName);
        Assert.Equal("Admin", model.AccessMode);
        Assert.True(model.CanPlay);
        Assert.True(model.CanManageLibrary);
    }

    private HomeController CreateController(DefaultHttpContext httpContext)
    {
        var httpContextAccessor = CreateHttpContextAccessor(httpContext);

        // --- Profile and Access services ---
        var currentProfile = new CurrentProfileService(Db, httpContextAccessor);
        var config = new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["Access:AdminAlways"] = "false"
            }!)
            .Build();
        var currentAccess = new CurrentAccessService(
            currentProfile, config, httpContextAccessor, Db, new EphemeralDataProtectionProvider());

        // --- Gameplay telemetry ---
        var telemetry = new GamePlayTelemetryService(Db);

        // --- Nosebleed services ---
        var nosebleedOptions = Options.Create(new NosebleedOptions { Enabled = false });
        var nosebleedTicketSigner = new NosebleedTicketSigner(
            nosebleedOptions, NullLogger<NosebleedTicketSigner>.Instance);

        var serviceCollection = new ServiceCollection();
        serviceCollection.AddSingleton(Db);
        var serviceProvider = serviceCollection.BuildServiceProvider();
        var scopeFactory = serviceProvider.GetRequiredService<IServiceScopeFactory>();
        var httpClientFactory = new TestHttpClientFactory();

        var sessionManager = new NosebleedSessionManager(
            nosebleedOptions,
            scopeFactory,
            nosebleedTicketSigner,
            httpClientFactory,
            NullLogger<NosebleedSessionManager>.Instance);

        var relayMetrics = new NosebleedRelayMetrics();
        var processInspector = new NosebleedProcessInspector(nosebleedOptions);

        // --- Libretro services (minimal - no dat files) ---
        var tempRoot = Path.Combine(Path.GetTempPath(), "gv-tests", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(tempRoot);
        var env = new FakeWebHostEnvironment(tempRoot);

        var libretroOptions = Options.Create(new LibretroDatabaseOptions
        {
            RootPath = "App_Data/libretro-database"
        });
        var libretroStore = new LibretroDatabaseStore(env, libretroOptions);

        var memoryCache = new MemoryCache(new MemoryCacheOptions());
        var systemDat = new SystemDatIndexProvider(env, memoryCache);

        var libraryOptions = Options.Create(new LibraryStorageOptions
        {
            RootPath = "App_Data/library"
        });
        var systemFileStorage = new SystemFileStorage(env, libraryOptions);

        // --- Mock internal jobs client (not used in Index) ---
        var mockJobs = new Moq.Mock<IInternalJobsClient>();

        var controller = new HomeController(
            Db,
            libretroStore,
            systemDat,
            systemFileStorage,
            mockJobs.Object,
            telemetry,
            sessionManager,
            nosebleedTicketSigner,
            relayMetrics,
            processInspector,
            currentProfile,
            currentAccess)
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = httpContext
            }
        };

        return controller;
    }

    private static void InjectManagedSession(HomeController controller, string key, NosebleedSession session)
    {
        // Navigate through controller -> field -> nosebleedSessions -> _sessions
        const BindingFlags flags = BindingFlags.Instance | BindingFlags.NonPublic;

        var nosebleedSessionsField = typeof(HomeController)
            .GetFields(flags)
            .First(f => f.FieldType == typeof(NosebleedSessionManager));
        Assert.NotNull(nosebleedSessionsField);
        var sessionManager = (NosebleedSessionManager)nosebleedSessionsField!.GetValue(controller)!;

        var sessionsField = typeof(NosebleedSessionManager).GetField("_sessions", flags);
        Assert.NotNull(sessionsField);
        var sessions = sessionsField!.GetValue(sessionManager);
        Assert.NotNull(sessions);

        var managedSessionType = typeof(NosebleedSessionManager).GetNestedType("ManagedSession", flags);
        Assert.NotNull(managedSessionType);
        var managedSession = System.Runtime.CompilerServices.RuntimeHelpers.GetUninitializedObject(managedSessionType!);
        Assert.NotNull(managedSession);

        var sessionField = managedSessionType!.GetField("<Session>k__BackingField", flags);
        var processField = managedSessionType.GetField("<Process>k__BackingField", flags);
        Assert.NotNull(sessionField);
        Assert.NotNull(processField);
        sessionField!.SetValue(managedSession, session);
        processField!.SetValue(managedSession, Process.GetCurrentProcess());

        var tryAdd = sessions!.GetType().GetMethod("TryAdd");
        Assert.NotNull(tryAdd);
        var added = tryAdd!.Invoke(sessions, [key, managedSession]);
        Assert.True(added is true);
    }

    private sealed class TestHttpClientFactory : IHttpClientFactory
    {
        public HttpClient CreateClient(string name) => new();
    }

    private sealed class FakeWebHostEnvironment(string contentRootPath) : IWebHostEnvironment
    {
        public string EnvironmentName { get; set; } = "Testing";
        public string ApplicationName { get; set; } = "games-vault.Tests";
        public string WebRootPath { get; set; } = contentRootPath;
        public Microsoft.Extensions.FileProviders.IFileProvider WebRootFileProvider { get; set; } = new Microsoft.Extensions.FileProviders.NullFileProvider();
        public string ContentRootPath { get; set; } = contentRootPath;
        public Microsoft.Extensions.FileProviders.IFileProvider ContentRootFileProvider { get; set; } = new Microsoft.Extensions.FileProviders.NullFileProvider();
    }
}
