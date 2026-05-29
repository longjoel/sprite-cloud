using games_vault.Libretro.Import;
using Microsoft.AspNetCore.Hosting;
using Microsoft.Extensions.FileProviders;
using Microsoft.Extensions.Options;

namespace games_vault.Tests;

public sealed class GameFileStorageTests
{
    [Fact]
    public async Task StoreAsync_reuses_existing_canonical_arcade_file_when_crc_matches()
    {
        var contentRoot = CreateTempDirectory();
        var libraryRoot = CreateTempDirectory();
        var storage = CreateStorage(contentRoot, libraryRoot);
        var romBytes = Enumerable.Range(0, 32).Select(i => (byte)i).ToArray();
        var crc32 = await ComputeCrcAsync(romBytes);

        var firstPath = await storage.StoreAsync(
            () => new MemoryStream(romBytes, writable: false),
            displayName: "joust.zip",
            systemName: "FBNeo - Arcade Games",
            crc32: crc32,
            sizeBytes: romBytes.Length,
            cancellationToken: CancellationToken.None,
            preferredFileName: "joust.zip",
            rejectOnNameCollision: true);

        var secondPath = await storage.StoreAsync(
            () => new MemoryStream(romBytes, writable: false),
            displayName: "joust(1).zip",
            systemName: "FBNeo - Arcade Games",
            crc32: crc32,
            sizeBytes: romBytes.Length,
            cancellationToken: CancellationToken.None,
            preferredFileName: "joust.zip",
            rejectOnNameCollision: true);

        Assert.Equal(firstPath, secondPath);
        Assert.Equal("roms/FBNeo - Arcade Games/joust.zip", firstPath);
    }

    [Fact]
    public async Task StoreAsync_rejects_conflicting_arcade_bytes_for_same_canonical_filename()
    {
        var contentRoot = CreateTempDirectory();
        var libraryRoot = CreateTempDirectory();
        var storage = CreateStorage(contentRoot, libraryRoot);
        var originalBytes = Enumerable.Range(0, 32).Select(i => (byte)i).ToArray();
        var conflictingBytes = Enumerable.Range(0, 32).Select(i => (byte)(255 - i)).ToArray();

        await storage.StoreAsync(
            () => new MemoryStream(originalBytes, writable: false),
            displayName: "joust.zip",
            systemName: "FBNeo - Arcade Games",
            crc32: await ComputeCrcAsync(originalBytes),
            sizeBytes: originalBytes.Length,
            cancellationToken: CancellationToken.None,
            preferredFileName: "joust.zip",
            rejectOnNameCollision: true);

        var ex = await Assert.ThrowsAsync<IOException>(() => storage.StoreAsync(
            () => new MemoryStream(conflictingBytes, writable: false),
            displayName: "joust(1).zip",
            systemName: "FBNeo - Arcade Games",
            crc32: ComputeCrcAsync(conflictingBytes).GetAwaiter().GetResult(),
            sizeBytes: conflictingBytes.Length,
            cancellationToken: CancellationToken.None,
            preferredFileName: "joust.zip",
            rejectOnNameCollision: true));

        Assert.Contains("canonical arcade filename", ex.Message, StringComparison.OrdinalIgnoreCase);
    }

    private static GameFileStorage CreateStorage(string contentRoot, string libraryRoot) =>
        new(
            new FakeEnvironment(contentRoot),
            Options.Create(new LibraryStorageOptions { RootPath = libraryRoot }));

    private static async Task<string> ComputeCrcAsync(byte[] bytes)
    {
        await using var stream = new MemoryStream(bytes, writable: false);
        return (await games_vault.Libretro.Crc32.ComputeAsync(stream, CancellationToken.None)).ToString("X8");
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
}
