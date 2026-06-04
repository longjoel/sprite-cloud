using games_vault.Data;
using games_vault.Gameplay;
using games_vault.Libretro.Import;
using games_vault.Models;
using games_vault.Nosebleed;
using Microsoft.AspNetCore.Hosting;
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.FileProviders;
using Microsoft.Extensions.Options;
using Microsoft.Extensions.Logging.Abstractions;

namespace games_vault.Tests;

public sealed class BatterySaveRuntimeSyncServiceTests
{
    [Fact]
    public async Task CaptureRuntimeSaveRevisionsAsync_persists_save_state_slot_and_prepare_restores_it_for_new_session()
    {
        await using var fixture = await CreateFixtureAsync();
        await SeedGameAsync(fixture.Db, profileId: 12, gameId: 88, gameFileId: 144);

        var sessionA = "games-vault-88-144-capture-state-a";
        var sessionB = "games-vault-88-144-restore-state-b";
        var runtimeDir = fixture.RuntimeSyncService.GetRuntimeSaveDirectory(sessionA);
        Directory.CreateDirectory(Path.Combine(runtimeDir, "states", "sonic"));
        await File.WriteAllBytesAsync(Path.Combine(runtimeDir, "states", "sonic", "slot-01.state"), new byte[] { 7, 6, 5, 4 });

        var captured = await fixture.RuntimeSyncService.CaptureRuntimeSaveRevisionsAsync(
            BatterySavePolicy.PerProfile(12),
            88,
            144,
            "Sega - Mega Drive - Genesis",
            sessionA,
            CancellationToken.None);

        var restored = await fixture.RuntimeSyncService.PrepareRuntimeSaveDirectoryAsync(
            BatterySavePolicy.PerProfile(12),
            88,
            144,
            "Sega - Mega Drive - Genesis",
            sessionB,
            "sonic.gb",
            CancellationToken.None);

        var restoredPath = Path.Combine(fixture.RuntimeSyncService.GetRuntimeSaveDirectory(sessionB), "states", "sonic", "slot-01.state");
        Assert.Equal(1, captured);
        Assert.Equal(1, restored);
        Assert.True(File.Exists(restoredPath));
        Assert.Equal(new byte[] { 7, 6, 5, 4 }, await File.ReadAllBytesAsync(restoredPath));
    }

    [Fact]
    public async Task PrepareRuntimeSaveDirectoryAsync_restores_latest_revision_into_runtime_directory()
    {
        await using var fixture = await CreateFixtureAsync();
        await SeedGameAsync(fixture.Db, profileId: 12, gameId: 88, gameFileId: 144);

        await using (var input = new MemoryStream(new byte[] { 1, 2, 3, 4 }, writable: false))
        {
            await fixture.BatterySaveService.AppendRuntimeRevisionAsync(
                12,
                88,
                144,
                "Sega - Mega Drive - Genesis",
                coreKey: null,
                key: "default",
                fileName: "sonic.srm",
                content: input,
                timestampUtc: new DateTime(2026, 6, 2, 23, 20, 0, DateTimeKind.Utc),
                cancellationToken: CancellationToken.None);
        }

        var restored = await fixture.RuntimeSyncService.PrepareRuntimeSaveDirectoryAsync(
            BatterySavePolicy.PerProfile(12),
            88,
            144,
            "Sega - Mega Drive - Genesis",
            "games-vault-88-144-testsession",
            "sonic.gb",
            CancellationToken.None);

        var runtimePath = Path.Combine(fixture.RuntimeSyncService.GetRuntimeSaveDirectory("games-vault-88-144-testsession"), "sonic.srm");
        Assert.Equal(1, restored);
        Assert.True(File.Exists(runtimePath));
        Assert.Equal(new byte[] { 1, 2, 3, 4 }, await File.ReadAllBytesAsync(runtimePath));
    }

    [Fact]
    public async Task CaptureRuntimeSaveRevisionsAsync_appends_runtime_revision_from_runtime_directory()
    {
        await using var fixture = await CreateFixtureAsync();
        await SeedGameAsync(fixture.Db, profileId: 12, gameId: 88, gameFileId: 144);

        var runtimeDir = fixture.RuntimeSyncService.GetRuntimeSaveDirectory("games-vault-88-144-capture");
        Directory.CreateDirectory(runtimeDir);
        await File.WriteAllBytesAsync(Path.Combine(runtimeDir, "sonic.srm"), new byte[] { 9, 8, 7, 6 });

        var captured = await fixture.RuntimeSyncService.CaptureRuntimeSaveRevisionsAsync(
            BatterySavePolicy.PerProfile(12),
            88,
            144,
            "Sega - Mega Drive - Genesis",
            "games-vault-88-144-capture",
            CancellationToken.None);

        var latest = await fixture.BatterySaveService.GetLatestRevisionAsync(12, 88, 144, null, "default", "sonic.srm", CancellationToken.None);
        Assert.Equal(1, captured);
        Assert.NotNull(latest);
        Assert.Equal("runtime", latest!.Source);
    }

    [Fact]
    public async Task PrepareRuntimeSaveDirectoryAsync_skips_restore_for_none_policy()
    {
        await using var fixture = await CreateFixtureAsync();
        await SeedGameAsync(fixture.Db, profileId: 12, gameId: 88, gameFileId: 144);

        var restored = await fixture.RuntimeSyncService.PrepareRuntimeSaveDirectoryAsync(
            BatterySavePolicy.None(),
            88,
            144,
            "Sega - Mega Drive - Genesis",
            "games-vault-88-144-none",
            "sonic.gb",
            CancellationToken.None);

        Assert.Equal(0, restored);
        Assert.False(Directory.Exists(fixture.RuntimeSyncService.GetRuntimeSaveDirectory("games-vault-88-144-none")));
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

    private static async Task<TestFixture> CreateFixtureAsync()
    {
        var connection = new SqliteConnection("Data Source=:memory:");
        await connection.OpenAsync();

        var options = new DbContextOptionsBuilder<AppDbContext>()
            .UseSqlite(connection)
            .Options;

        var db = new AppDbContext(options);
        await db.Database.EnsureCreatedAsync();

        var tempRoot = Path.Combine(Path.GetTempPath(), $"battery-save-runtime-sync-{Guid.NewGuid():N}");
        Directory.CreateDirectory(tempRoot);
        var env = new FakeEnvironment(tempRoot);
        var storageOptions = Options.Create(new LibraryStorageOptions
        {
            RootPath = Path.Combine(tempRoot, "library"),
            ProfileSaveRootPath = Path.Combine(tempRoot, "profile-saves")
        });
        var storage = new ProfileGameSaveStorage(env, storageOptions);
        var batterySaveService = new ProfileBatterySaveService(db, storage);
        var runtimeSyncService = new BatterySaveRuntimeSyncService(
            batterySaveService,
            storage,
            Options.Create(new NosebleedOptions
            {
                SessionRoot = Path.Combine(tempRoot, "nosebleed-sessions")
            }),
            NullLogger<BatterySaveRuntimeSyncService>.Instance);

        return new TestFixture(connection, db, batterySaveService, runtimeSyncService, tempRoot);
    }

    private sealed record TestFixture(
        SqliteConnection Connection,
        AppDbContext Db,
        ProfileBatterySaveService BatterySaveService,
        BatterySaveRuntimeSyncService RuntimeSyncService,
        string TempRoot) : IAsyncDisposable
    {
        public async ValueTask DisposeAsync()
        {
            await Db.DisposeAsync();
            await Connection.DisposeAsync();
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

    private sealed class FakeEnvironment(string contentRootPath) : IWebHostEnvironment
    {
        public string EnvironmentName { get; set; } = "Testing";
        public string ApplicationName { get; set; } = "games-vault.Tests";
        public string WebRootPath { get; set; } = contentRootPath;
        public IFileProvider WebRootFileProvider { get; set; } = new NullFileProvider();
        public string ContentRootPath { get; set; } = contentRootPath;
        public IFileProvider ContentRootFileProvider { get; set; } = new NullFileProvider();
    }
}
