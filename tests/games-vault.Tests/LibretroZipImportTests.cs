using System.IO.Compression;
using games_vault.BackgroundJobs;
using games_vault.Data;
using games_vault.Libretro;
using games_vault.Libretro.Dat;
using games_vault.Libretro.Import;
using games_vault.Models;
using Microsoft.AspNetCore.Hosting;
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.FileProviders;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace games_vault.Tests;

public sealed class LibretroZipImportTests
{
    [Fact]
    public async Task ScanPathsAsync_includes_outer_zip_and_nested_member_entries()
    {
        var tempRoot = CreateTempDirectory();
        var zipPath = Path.Combine(tempRoot, "joust.zip");
        CreateZip(zipPath, ("3006-19.7b", new byte[] { 1, 2, 3, 4 }));

        var scanner = new UploadFileScanner();
        var scanned = await scanner.ScanPathsAsync(new[] { zipPath }, CancellationToken.None);

        Assert.Contains(scanned, x => x.DisplayName == "joust.zip");
        Assert.Contains(scanned, x => x.DisplayName == "joust.zip:3006-19.7b");
    }

    [Fact]
    public async Task ImportFromStagedDirectoryAsync_prefers_playable_mame_zip_over_member_crc_entries()
    {
        var contentRoot = CreateTempDirectory();
        var libraryRoot = CreateTempDirectory();
        var stagingRoot = CreateTempDirectory();
        var zipPath = Path.Combine(stagingRoot, "joust.zip");
        var memberBytes = Enumerable.Range(0, 64).Select(i => (byte)i).ToArray();
        CreateZip(zipPath, ("3006-19.7b", memberBytes));

        var outerCrc = await ComputeCrcAsync(zipPath);
        var memberCrc = await ComputeCrcAsync(Path.Combine(CreateExtractDirectory(zipPath), "3006-19.7b"));
        CreateLibretroDatabase(contentRoot, outerCrc, new FileInfo(zipPath).Length, memberCrc, memberBytes.Length);

        await using var fixture = await CreateFixtureAsync(contentRoot);
        var environment = new FakeEnvironment(contentRoot);
        var storageOptions = Options.Create(new LibraryStorageOptions { RootPath = libraryRoot });
        var databaseOptions = Options.Create(new LibretroDatabaseOptions { RootPath = "libretro-db" });
        var fileStorage = new GameFileStorage(environment, storageOptions);
        var store = new LibretroDatabaseStore(environment, databaseOptions);
        var parser = new LibretroDatParser();
        var builder = new LibretroDatIndexBuilder(store, parser, LoggerFactory.Create(_ => { }).CreateLogger<LibretroDatIndexBuilder>());
        var importer = new GameUploadImporter(
            fixture.Db,
            new UploadFileScanner(),
            builder,
            fileStorage,
            LoggerFactory.Create(_ => { }).CreateLogger<GameUploadImporter>());

        var job = new BackgroundJob
        {
            Command = "test",
            CreatedUtc = DateTime.UtcNow,
            UpdatedUtc = DateTime.UtcNow,
            Status = BackgroundJobStatus.Queued,
            PayloadJson = "{}"
        };
        fixture.Db.BackgroundJobs.Add(job);
        await fixture.Db.SaveChangesAsync();

        var context = new BackgroundJobExecutionContext(
            job,
            fixture.Db,
            new ServiceCollection().BuildServiceProvider(),
            LoggerFactory.Create(_ => { }).CreateLogger("test"));

        var result = await importer.ImportFromStagedDirectoryAsync(stagingRoot, context, CancellationToken.None);

        Assert.Equal(2, result.TotalScannedFileCount);
        Assert.Equal(1, result.TotalMatchedFileCount);

        var game = await fixture.Db.Games.Include(x => x.Files).SingleAsync();
        var file = Assert.Single(game.Files);
        Assert.Equal("MAME 2003-Plus", game.SystemName);
        Assert.Equal("Joust (White-Green label)", game.Name);
        Assert.Equal("joust.zip", file.Name);
        Assert.Equal("joust.zip", file.OriginalFileName);
        Assert.Equal(outerCrc, file.Crc32);
        Assert.NotNull(file.StoragePath);

        var storedPath = fileStorage.GetAbsolutePath(file.StoragePath!);
        Assert.True(File.Exists(storedPath));
        Assert.Equal(new FileInfo(zipPath).Length, new FileInfo(storedPath).Length);
    }

    private static void CreateLibretroDatabase(string contentRoot, string outerCrc, long outerSize, string memberCrc, long memberSize)
    {
        var datDir = Path.Combine(contentRoot, "libretro-db", "dat");
        var memberDir = Path.Combine(contentRoot, "libretro-db", "metadat", "mame-member");
        Directory.CreateDirectory(datDir);
        Directory.CreateDirectory(memberDir);

        File.WriteAllText(Path.Combine(datDir, "MAME 2003-Plus.dat"), $"""
clrmamepro (
    name "MAME 2003-Plus"
)

game (
    name "Joust (White-Green label)"
    rom ( name "joust.zip" size {outerSize} crc {outerCrc} )
)
""");

        File.WriteAllText(Path.Combine(memberDir, "MAME.dat"), $"""
clrmamepro (
    name "MAME"
)

game (
    name "Joust (White-Green label)"
    rom ( name "3006-19.7b" size {memberSize} crc {memberCrc} )
)
""");
    }

    private static string CreateExtractDirectory(string zipPath)
    {
        var dir = CreateTempDirectory();
        ZipFile.ExtractToDirectory(zipPath, dir);
        return dir;
    }

    private static void CreateZip(string zipPath, params (string Name, byte[] Bytes)[] entries)
    {
        using var archive = ZipFile.Open(zipPath, ZipArchiveMode.Create);
        foreach (var (name, bytes) in entries)
        {
            var entry = archive.CreateEntry(name, CompressionLevel.NoCompression);
            using var stream = entry.Open();
            stream.Write(bytes, 0, bytes.Length);
        }
    }

    private static async Task<string> ComputeCrcAsync(string path)
    {
        await using var stream = File.OpenRead(path);
        return (await Crc32.ComputeAsync(stream, CancellationToken.None)).ToString("X8");
    }

    private static async Task<TestFixture> CreateFixtureAsync(string contentRoot)
    {
        var connection = new SqliteConnection("Data Source=:memory:");
        await connection.OpenAsync();

        var options = new DbContextOptionsBuilder<AppDbContext>()
            .UseSqlite(connection)
            .Options;

        var db = new AppDbContext(options);
        await db.Database.EnsureCreatedAsync();
        return new TestFixture(connection, db, contentRoot);
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

    private sealed class TestFixture(SqliteConnection connection, AppDbContext db, string contentRoot) : IAsyncDisposable
    {
        public SqliteConnection Connection { get; } = connection;
        public AppDbContext Db { get; } = db;
        public string ContentRoot { get; } = contentRoot;

        public async ValueTask DisposeAsync()
        {
            await Db.DisposeAsync();
            await Connection.DisposeAsync();
        }
    }
}
