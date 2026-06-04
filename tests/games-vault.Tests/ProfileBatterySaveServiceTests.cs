using games_vault.Data;
using games_vault.Gameplay;
using games_vault.Libretro.Import;
using games_vault.Models;
using Microsoft.AspNetCore.Hosting;
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.FileProviders;
using Microsoft.Extensions.Options;

namespace games_vault.Tests;

public sealed class ProfileBatterySaveServiceTests
{
    [Fact]
    public async Task AppendUploadedRevisionAsync_creates_stream_and_first_revision()
    {
        await using var fixture = await CreateFixtureAsync();
        var subject = fixture.CreateService();

        await SeedGameAsync(fixture.Db, profileId: 12, gameId: 88, gameFileId: 144);

        await using var input = new MemoryStream(new byte[] { 1, 2, 3, 4 }, writable: false);
        var revision = await subject.AppendUploadedRevisionAsync(
            profileId: 12,
            gameId: 88,
            gameFileId: 144,
            systemName: "Sega - Mega Drive - Genesis",
            coreKey: "genesis_plus_gx",
            key: "default",
            fileName: "sonic.srm",
            originalUploadFileName: "sonic.srm",
            content: input,
            timestampUtc: new DateTime(2026, 6, 2, 23, 20, 0, DateTimeKind.Utc),
            cancellationToken: CancellationToken.None);

        var stream = await fixture.Db.ProfileGameSaves
            .Include(x => x.LatestRevision)
            .Include(x => x.Revisions)
            .SingleAsync();

        Assert.Equal(12, stream.ProfileId);
        Assert.Equal(88, stream.GameId);
        Assert.Equal(144, stream.GameFileId);
        Assert.Equal("battery", stream.Kind);
        Assert.Equal(revision.Id, stream.LatestRevisionId);
        Assert.Single(stream.Revisions);
        Assert.Equal("upload", revision.Source);
        Assert.Equal("sonic.srm", revision.OriginalUploadFileName);
        Assert.True(File.Exists(fixture.Storage.GetAbsolutePath(revision.StoragePath)));
    }

    [Fact]
    public async Task AppendRuntimeRevisionAsync_adds_second_revision_when_bytes_change()
    {
        await using var fixture = await CreateFixtureAsync();
        var subject = fixture.CreateService();

        await SeedGameAsync(fixture.Db, profileId: 12, gameId: 88, gameFileId: 144);

        await using (var first = new MemoryStream(new byte[] { 1, 2, 3 }, writable: false))
        {
            await subject.AppendRuntimeRevisionAsync(
                profileId: 12,
                gameId: 88,
                gameFileId: 144,
                systemName: "Sega - Mega Drive - Genesis",
                coreKey: "genesis_plus_gx",
                key: "default",
                fileName: "sonic.srm",
                content: first,
                timestampUtc: new DateTime(2026, 6, 2, 23, 20, 0, DateTimeKind.Utc),
                cancellationToken: CancellationToken.None);
        }

        await using (var second = new MemoryStream(new byte[] { 4, 5, 6 }, writable: false))
        {
            await subject.AppendRuntimeRevisionAsync(
                profileId: 12,
                gameId: 88,
                gameFileId: 144,
                systemName: "Sega - Mega Drive - Genesis",
                coreKey: "genesis_plus_gx",
                key: "default",
                fileName: "sonic.srm",
                content: second,
                timestampUtc: new DateTime(2026, 6, 2, 23, 21, 0, DateTimeKind.Utc),
                cancellationToken: CancellationToken.None);
        }

        var stream = await fixture.Db.ProfileGameSaves
            .Include(x => x.LatestRevision)
            .Include(x => x.Revisions.OrderBy(r => r.RevisionTimestampUtc))
            .SingleAsync();

        Assert.Equal(2, stream.Revisions.Count);
        Assert.Equal("runtime", stream.Revisions.First().Source);
        Assert.Equal("runtime", stream.Revisions.Last().Source);
        Assert.Equal(stream.Revisions.Last().Id, stream.LatestRevisionId);
    }

    [Fact]
    public async Task AppendRuntimeRevisionAsync_dedupes_identical_bytes_against_latest_revision()
    {
        await using var fixture = await CreateFixtureAsync();
        var subject = fixture.CreateService();

        await SeedGameAsync(fixture.Db, profileId: 12, gameId: 88, gameFileId: 144);

        var bytes = new byte[] { 9, 8, 7, 6 };
        await using (var first = new MemoryStream(bytes, writable: false))
        {
            await subject.AppendRuntimeRevisionAsync(12, 88, 144, "Sega - Mega Drive - Genesis", "genesis_plus_gx", "default", "sonic.srm", first, new DateTime(2026, 6, 2, 23, 20, 0, DateTimeKind.Utc), CancellationToken.None);
        }

        await using (var second = new MemoryStream(bytes, writable: false))
        {
            await subject.AppendRuntimeRevisionAsync(12, 88, 144, "Sega - Mega Drive - Genesis", "genesis_plus_gx", "default", "sonic.srm", second, new DateTime(2026, 6, 2, 23, 21, 0, DateTimeKind.Utc), CancellationToken.None);
        }

        var stream = await fixture.Db.ProfileGameSaves
            .Include(x => x.Revisions)
            .SingleAsync();

        Assert.Single(stream.Revisions);
    }

    [Fact]
    public async Task GetLatestRevisionAsync_returns_most_recent_revision_for_matching_stream()
    {
        await using var fixture = await CreateFixtureAsync();
        var subject = fixture.CreateService();

        await SeedGameAsync(fixture.Db, profileId: 12, gameId: 88, gameFileId: 144);

        await using (var first = new MemoryStream(new byte[] { 1 }, writable: false))
        {
            await subject.AppendRuntimeRevisionAsync(12, 88, 144, "Sega - Mega Drive - Genesis", "genesis_plus_gx", "default", "sonic.srm", first, new DateTime(2026, 6, 2, 23, 20, 0, DateTimeKind.Utc), CancellationToken.None);
        }

        await using (var second = new MemoryStream(new byte[] { 2 }, writable: false))
        {
            await subject.AppendUploadedRevisionAsync(12, 88, 144, "Sega - Mega Drive - Genesis", "genesis_plus_gx", "default", "sonic.srm", "sonic-upload.srm", second, new DateTime(2026, 6, 2, 23, 22, 0, DateTimeKind.Utc), CancellationToken.None);
        }

        var latest = await subject.GetLatestRevisionAsync(12, 88, 144, "genesis_plus_gx", "default", "sonic.srm", CancellationToken.None);

        Assert.NotNull(latest);
        Assert.Equal("upload", latest!.Source);
        Assert.Equal("sonic-upload.srm", latest.OriginalUploadFileName);
    }

    [Fact]
    public async Task PromoteRevisionToLatestAsync_points_latest_at_existing_revision_without_creating_new_one()
    {
        await using var fixture = await CreateFixtureAsync();
        var subject = fixture.CreateService();

        await SeedGameAsync(fixture.Db, profileId: 12, gameId: 88, gameFileId: 144);

        await using (var first = new MemoryStream(new byte[] { 1, 2, 3 }, writable: false))
        {
            await subject.AppendRuntimeRevisionAsync(12, 88, 144, "Sega - Mega Drive - Genesis", "genesis_plus_gx", "default", "sonic.srm", first, new DateTime(2026, 6, 2, 23, 20, 0, DateTimeKind.Utc), CancellationToken.None);
        }

        await using (var second = new MemoryStream(new byte[] { 4, 5, 6 }, writable: false))
        {
            await subject.AppendUploadedRevisionAsync(12, 88, 144, "Sega - Mega Drive - Genesis", "genesis_plus_gx", "default", "sonic.srm", "manual-upload.srm", second, new DateTime(2026, 6, 2, 23, 21, 0, DateTimeKind.Utc), CancellationToken.None);
        }

        var revision = await fixture.Db.ProfileGameSaveRevisions
            .AsNoTracking()
            .OrderBy(x => x.Id)
            .FirstAsync();

        var promoted = await subject.PromoteRevisionToLatestAsync(12, revision.Id, new DateTime(2026, 6, 2, 23, 22, 0, DateTimeKind.Utc), CancellationToken.None);

        var stream = await fixture.Db.ProfileGameSaves
            .Include(x => x.Revisions)
            .SingleAsync();

        Assert.NotNull(promoted);
        Assert.Equal(revision.Id, stream.LatestRevisionId);
        Assert.Equal(2, stream.Revisions.Count);
        Assert.Equal("runtime", stream.Revisions.OrderBy(x => x.Id).First().Source);
        Assert.Equal("upload", stream.Revisions.OrderBy(x => x.Id).Last().Source);
    }

    [Fact]
    public async Task GetHistoryAsync_returns_newest_first_with_revision_metadata()
    {
        await using var fixture = await CreateFixtureAsync();
        var subject = fixture.CreateService();

        await SeedGameAsync(fixture.Db, profileId: 12, gameId: 88, gameFileId: 144);

        await using (var first = new MemoryStream(new byte[] { 1 }, writable: false))
        {
            await subject.AppendRuntimeRevisionAsync(12, 88, 144, "Sega - Mega Drive - Genesis", "genesis_plus_gx", "default", "sonic.srm", first, new DateTime(2026, 6, 2, 23, 20, 0, DateTimeKind.Utc), CancellationToken.None);
        }

        await using (var second = new MemoryStream(new byte[] { 2, 3 }, writable: false))
        {
            await subject.AppendUploadedRevisionAsync(12, 88, 144, "Sega - Mega Drive - Genesis", "genesis_plus_gx", "default", "sonic.srm", "manual-upload.srm", second, new DateTime(2026, 6, 2, 23, 21, 0, DateTimeKind.Utc), CancellationToken.None);
        }

        var history = await subject.GetHistoryAsync(12, 88, 144, CancellationToken.None);

        Assert.Equal(2, history.Count);
        Assert.True(history[0].RevisionTimestampUtc > history[1].RevisionTimestampUtc);
        Assert.Equal("upload", history[0].Source);
        Assert.Equal("runtime", history[1].Source);
        Assert.Equal("manual-upload.srm", history[0].OriginalUploadFileName);
        Assert.True(history[0].IsLatest);
        Assert.False(history[1].IsLatest);
    }

    [Fact]
    public async Task AppendRuntimeRevisionAsync_isolates_streams_by_profile_and_gamefile()
    {
        await using var fixture = await CreateFixtureAsync();
        var subject = fixture.CreateService();

        await SeedGameAsync(fixture.Db, profileId: 12, gameId: 88, gameFileId: 144);
        await SeedGameAsync(fixture.Db, profileId: 13, gameId: 88, gameFileId: 145);

        await using (var first = new MemoryStream(new byte[] { 1 }, writable: false))
        {
            await subject.AppendRuntimeRevisionAsync(12, 88, 144, "Sega - Mega Drive - Genesis", "genesis_plus_gx", "default", "sonic.srm", first, new DateTime(2026, 6, 2, 23, 20, 0, DateTimeKind.Utc), CancellationToken.None);
        }

        await using (var second = new MemoryStream(new byte[] { 2 }, writable: false))
        {
            await subject.AppendRuntimeRevisionAsync(13, 88, 145, "Sega - Mega Drive - Genesis", "genesis_plus_gx", "default", "sonic.srm", second, new DateTime(2026, 6, 2, 23, 21, 0, DateTimeKind.Utc), CancellationToken.None);
        }

        var streams = await fixture.Db.ProfileGameSaves
            .OrderBy(x => x.ProfileId)
            .ThenBy(x => x.GameFileId)
            .ToListAsync();

        Assert.Equal(2, streams.Count);
        Assert.Equal((12, 144), (streams[0].ProfileId, streams[0].GameFileId));
        Assert.Equal((13, 145), (streams[1].ProfileId, streams[1].GameFileId));
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

        var contentRoot = CreateTempDirectory();
        var profileSaveRoot = CreateTempDirectory();
        var storage = new ProfileGameSaveStorage(
            new FakeEnvironment(contentRoot),
            Options.Create(new LibraryStorageOptions { ProfileSaveRootPath = profileSaveRoot }));

        return new TestFixture(connection, db, storage, contentRoot, profileSaveRoot);
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

    private sealed record TestFixture(SqliteConnection Connection, AppDbContext Db, ProfileGameSaveStorage Storage, string ContentRoot, string ProfileSaveRoot) : IAsyncDisposable
    {
        public ProfileBatterySaveService CreateService() => new(Db, Storage);

        public async ValueTask DisposeAsync()
        {
            await Db.DisposeAsync();
            await Connection.DisposeAsync();
        }
    }
}
