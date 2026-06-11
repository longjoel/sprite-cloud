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
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.FileProviders;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;

namespace games_vault.Tests;

public sealed class ProfileBatterySaveUploadTests
{
    [Fact]
    public async Task Upload_post_creates_revision_and_history_get_returns_view()
    {
        await using var fixture = await CreateFixtureAsync();
        var controller = fixture.CreateController();

        await SeedGameAsync(fixture.Db, profileId: 12, gameId: 88, gameFileId: 144);

        var upload = new FormFile(new MemoryStream(new byte[] { 9, 8, 7 }, writable: false), 0, 3, "Upload", "manual-upload.srm");
        var result = await controller.Upload(new games_vault.Models.ViewModels.ProfileBatterySaveUploadViewModel
        {
            GameId = 88,
            GameFileId = 144,
            Key = "default",
            FileName = "manual-upload.srm",
            Upload = upload
        }, CancellationToken.None);

        var redirect = Assert.IsType<RedirectToActionResult>(result);
        Assert.Equal(nameof(ProfileBatterySavesController.History), redirect.ActionName);

        var revision = await fixture.Db.ProfileGameSaveRevisions.SingleAsync();
        Assert.Equal("upload", revision.Source);
        Assert.Equal("manual-upload.srm", revision.OriginalUploadFileName);

        var historyResult = await controller.History(88, 144, CancellationToken.None);
        var view = Assert.IsType<ViewResult>(historyResult);
        var model = Assert.IsType<games_vault.Models.ViewModels.ProfileBatterySaveHistoryViewModel>(view.Model);
        Assert.Single(model.Revisions);
        Assert.True(model.Revisions[0].IsLatest);
    }

    [Fact]
    public async Task Rename_post_updates_save_filename_and_download_uses_latest_revision_filename()
    {
        await using var fixture = await CreateFixtureAsync();
        var controller = fixture.CreateController();

        await SeedGameAsync(fixture.Db, profileId: 12, gameId: 88, gameFileId: 144);

        await controller.Upload(new games_vault.Models.ViewModels.ProfileBatterySaveUploadViewModel
        {
            GameId = 88,
            GameFileId = 144,
            Key = "default",
            FileName = "first.srm",
            Upload = new FormFile(new MemoryStream(new byte[] { 1, 2, 3 }, writable: false), 0, 3, "Upload", "first.srm")
        }, CancellationToken.None);

        var save = await fixture.Db.ProfileGameSaves.SingleAsync();
        var revision = await fixture.Db.ProfileGameSaveRevisions.SingleAsync();

        var renameResult = await controller.Rename(88, 144, save.Id, "my-rename.srm", CancellationToken.None);
        Assert.IsType<RedirectToActionResult>(renameResult);

        var renamed = await fixture.Db.ProfileGameSaves.SingleAsync(x => x.Id == save.Id);
        Assert.Equal("my-rename.srm", renamed.FileName);

        var downloadResult = Assert.IsType<FileContentResult>(await controller.Download(88, 144, revision.Id, CancellationToken.None));
        Assert.Equal("application/octet-stream", downloadResult.ContentType);
        Assert.Equal("my-rename.srm", downloadResult.FileDownloadName);
        Assert.Equal(new byte[] { 1, 2, 3 }, downloadResult.FileContents);
    }

    [Fact]
    public async Task Delete_post_removes_a_revision_and_repoints_latest_then_deletes_last_revision()
    {
        await using var fixture = await CreateFixtureAsync();
        var controller = fixture.CreateController();

        await SeedGameAsync(fixture.Db, profileId: 12, gameId: 88, gameFileId: 144);

        await controller.Upload(new games_vault.Models.ViewModels.ProfileBatterySaveUploadViewModel
        {
            GameId = 88,
            GameFileId = 144,
            Key = "default",
            FileName = "first.srm",
            Upload = new FormFile(new MemoryStream(new byte[] { 1, 2, 3 }, writable: false), 0, 3, "Upload", "first.srm")
        }, CancellationToken.None);
        await controller.Upload(new games_vault.Models.ViewModels.ProfileBatterySaveUploadViewModel
        {
            GameId = 88,
            GameFileId = 144,
            Key = "default",
            FileName = "first.srm",
            Upload = new FormFile(new MemoryStream(new byte[] { 4, 5, 6 }, writable: false), 0, 3, "Upload", "first.srm")
        }, CancellationToken.None);

        var revisions = await fixture.Db.ProfileGameSaveRevisions.OrderBy(x => x.Id).ToListAsync();
        Assert.Equal(2, revisions.Count);

        var save = await fixture.Db.ProfileGameSaves.SingleAsync();
        var firstPath = fixture.Storage.GetAbsolutePath(revisions[0].StoragePath);
        var secondPath = fixture.Storage.GetAbsolutePath(revisions[1].StoragePath);
        Assert.True(File.Exists(firstPath));
        Assert.True(File.Exists(secondPath));

        var deleteLatest = await controller.Delete(88, 144, revisions[1].Id, CancellationToken.None);
        Assert.IsType<RedirectToActionResult>(deleteLatest);

        var remainingSave = await fixture.Db.ProfileGameSaves.SingleAsync(x => x.Id == save.Id);
        Assert.Equal(revisions[0].Id, remainingSave.LatestRevisionId);
        Assert.False(File.Exists(secondPath));
        Assert.True(File.Exists(firstPath));
        Assert.Single(await fixture.Db.ProfileGameSaveRevisions.ToListAsync());

        var deleteLast = await controller.Delete(88, 144, revisions[0].Id, CancellationToken.None);
        Assert.IsType<RedirectToActionResult>(deleteLast);
        Assert.Empty(await fixture.Db.ProfileGameSaves.ToListAsync());
        Assert.Empty(await fixture.Db.ProfileGameSaveRevisions.ToListAsync());
        Assert.False(File.Exists(firstPath));
    }

    [Fact]
    public async Task LoadAndReset_uses_active_room_even_when_player_is_temporarily_disconnected()
    {
        await using var fixture = await CreateFixtureAsync();
        var controller = fixture.CreateController();

        await SeedGameAsync(fixture.Db, profileId: 12, gameId: 88, gameFileId: 144);
        await SeedDisconnectedActiveRoomAsync(fixture.Db, profileId: 12, gameId: 88, gameFileId: 144);

        await controller.Upload(new games_vault.Models.ViewModels.ProfileBatterySaveUploadViewModel
        {
            GameId = 88,
            GameFileId = 144,
            Key = "default",
            FileName = "first.srm",
            Upload = new FormFile(new MemoryStream(new byte[] { 1, 1, 1 }, writable: false), 0, 3, "Upload", "first.srm")
        }, CancellationToken.None);

        var revision = await fixture.Db.ProfileGameSaveRevisions.AsNoTracking().SingleAsync();
        var result = await controller.LoadAndReset(88, 144, revision.Id, CancellationToken.None);
        Assert.IsType<RedirectToActionResult>(result);

        var diagnosticsJson = Assert.IsType<string>(controller.TempData["BatterySaveDiagnostics"]);
        Assert.Contains("game-144.srm", diagnosticsJson);

        var runtimePath = Path.Combine(fixture.RuntimeSync.GetRuntimeSaveDirectory("games-vault-88-144-disconnected"), "game-144.srm");
        Assert.True(File.Exists(runtimePath));
    }


    private static async Task<TestFixture> CreateFixtureAsync()
    {
        var scope = await TestDbFixture.CreateScopeAsync();
        var db = scope.Db;

        var contentRoot = CreateTempDirectory();
        var profileSaveRoot = CreateTempDirectory();
        var storage = new ProfileGameSaveStorage(
            new FakeEnvironment(contentRoot),
            Options.Create(new LibraryStorageOptions { ProfileSaveRootPath = profileSaveRoot }));
        var fileStorage = new GameFileStorage(
            new FakeEnvironment(contentRoot),
            Options.Create(new LibraryStorageOptions { RootPath = contentRoot }));

        var httpContext = new DefaultHttpContext();
        httpContext.Request.Headers.Cookie = $"{CurrentProfileService.CookieName}=12";
        var accessor = new TestHttpContextAccessor(httpContext);
        var currentProfile = new CurrentProfileService(db, accessor);
        var batterySaveService = new ProfileBatterySaveService(db, storage);
        var nosebleedOptions = Options.Create(new NosebleedOptions
        {
            Enabled = false,
            SessionRoot = CreateTempDirectory(),
            BinaryPath = "/bin/true",
            CoreRoot = CreateTempDirectory(),
            PublicHost = "127.0.0.1"
        });
        var runtimeSync = new BatterySaveRuntimeSyncService(
            batterySaveService,
            storage,
            nosebleedOptions,
            NullLogger<BatterySaveRuntimeSyncService>.Instance);
        var policyResolver = new BatterySavePolicyResolver();
        var sessionManager = new NosebleedSessionManager(
            nosebleedOptions,
            new EmptyServiceScopeFactory(),
            new NosebleedTicketSigner(Options.Create(new NosebleedOptions()), NullLogger<NosebleedTicketSigner>.Instance),
            new FakeHttpClientFactory(),
            new SystemCoreMappingResolver(nosebleedOptions),
            NullLogger<NosebleedSessionManager>.Instance);

        return new TestFixture(scope, db, storage, fileStorage, accessor, currentProfile, batterySaveService, runtimeSync, policyResolver, sessionManager, contentRoot, profileSaveRoot);
    }

    private static async Task SeedGameAsync(AppDbContext db, int profileId, int gameId, int gameFileId)
    {
        if (!await db.UserProfiles.AnyAsync(x => x.Id == profileId))
        {
            db.UserProfiles.Add(new UserProfile
            {
                Id = profileId,
                DisplayName = $"Profile {profileId}",
                PasskeyUserHandleBase64Url = $"handle-{profileId}",
                CreatedUtc = DateTime.UtcNow,
                UpdatedUtc = DateTime.UtcNow
            });
        }

        if (!await db.Games.AnyAsync(x => x.Id == gameId))
        {
            db.Games.Add(new Game
            {
                Id = gameId,
                Name = $"Game {gameId}",
                SystemName = "Sega - Mega Drive - Genesis",
                SizeBytes = 1,
                CreatedUtc = DateTime.UtcNow
            });
        }

        if (!await db.GameFiles.AnyAsync(x => x.Id == gameFileId))
        {
            db.GameFiles.Add(new GameFile
            {
                Id = gameFileId,
                GameId = gameId,
                Name = $"game-{gameFileId}.bin",
                SizeBytes = 1,
                StoragePath = $"roms/genesis/game-{gameFileId}.bin"
            });
        }

        await db.SaveChangesAsync();
    }

    private static async Task SeedDisconnectedActiveRoomAsync(AppDbContext db, int profileId, int gameId, int gameFileId)
    {
        var room = new GamePlayRoom
        {
            Code = "ABCD",
            GameId = gameId,
            GameFileId = gameFileId,
            CreatedByProfileId = profileId,
            Status = GamePlayRoomStatus.Active,
            CreatedUtc = DateTime.UtcNow,
            LastActiveUtc = DateTime.UtcNow,
            NosebleedSessionId = "games-vault-88-144-disconnected"
        };
        room.Participants.Add(new GamePlayRoomParticipant
        {
            ViewerId = "viewer-12",
            ProfileId = profileId,
            Role = GamePlayRoomParticipantRole.Player,
            Port = 0,
            IsConnected = false,
            JoinedUtc = DateTime.UtcNow,
            LastSeenUtc = DateTime.UtcNow
        });

        db.GamePlayRooms.Add(room);
        await db.SaveChangesAsync();
    }


    private static string CreateTempDirectory()
    {
        var path = Path.Combine(Path.GetTempPath(), "games-vault-tests", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(path);
        return path;
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

    private sealed class TestHttpContextAccessor(HttpContext httpContext) : IHttpContextAccessor
    {
        public HttpContext? HttpContext { get; set; } = httpContext;
    }

    private sealed class EmptyServiceScopeFactory : IServiceScopeFactory
    {
        public IServiceScope CreateScope() => new EmptyServiceScope();
    }

    private sealed class EmptyServiceScope : IServiceScope
    {
        public IServiceProvider ServiceProvider { get; } = new EmptyServiceProvider();
        public void Dispose() { }
    }

    private sealed class EmptyServiceProvider : IServiceProvider
    {
        public object? GetService(Type serviceType) => null;
    }

    private sealed class FakeHttpClientFactory : IHttpClientFactory
    {
        public HttpClient CreateClient(string name = "default") => new();
    }

    private sealed record TestFixture(
        TestDbFixture.Scope Scope,
        AppDbContext Db,
        ProfileGameSaveStorage Storage,
        GameFileStorage FileStorage,
        TestHttpContextAccessor Accessor,
        CurrentProfileService CurrentProfile,
        ProfileBatterySaveService BatterySaveService,
        BatterySaveRuntimeSyncService RuntimeSync,
        BatterySavePolicyResolver PolicyResolver,
        NosebleedSessionManager SessionManager,
        string ContentRoot,
        string ProfileSaveRoot) : IAsyncDisposable
    {
        public IDictionary<string, object> ControllerTempData { get; } = new Dictionary<string, object>();

        public ProfileBatterySavesController CreateController()
        {
            var controller = new ProfileBatterySavesController(Db, FileStorage, CurrentProfile, BatterySaveService, RuntimeSync, PolicyResolver, SessionManager)
            {
                ControllerContext = new ControllerContext { HttpContext = Accessor.HttpContext! },
                TempData = new TempDataDictionary(Accessor.HttpContext!, new TestTempDataProvider(ControllerTempData))
            };
            return controller;
        }

        public async ValueTask DisposeAsync()
        {
            await Scope.DisposeAsync();
        }
    }

    private sealed class TestTempDataProvider(IDictionary<string, object> store) : ITempDataProvider
    {
        public IDictionary<string, object> LoadTempData(HttpContext context) => store;
        public void SaveTempData(HttpContext context, IDictionary<string, object> values)
        {
            store.Clear();
            foreach (var pair in values)
            {
                store[pair.Key] = pair.Value;
            }
        }
    }
}
