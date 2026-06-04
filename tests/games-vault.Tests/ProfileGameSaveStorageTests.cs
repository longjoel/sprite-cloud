using System.Text.RegularExpressions;
using games_vault.Libretro.Import;
using Microsoft.AspNetCore.Hosting;
using Microsoft.Extensions.FileProviders;
using Microsoft.Extensions.Options;

namespace games_vault.Tests;

public sealed class ProfileGameSaveStorageTests
{
    [Fact]
    public async Task StoreRevisionAsync_writes_timestamped_revision_under_profile_save_root()
    {
        var contentRoot = CreateTempDirectory();
        var profileSaveRoot = CreateTempDirectory();
        var storage = CreateStorage(contentRoot, profileSaveRoot);
        var bytes = new byte[] { 1, 2, 3, 4 };

        var relativePath = await storage.StoreRevisionAsync(
            () => new MemoryStream(bytes, writable: false),
            profileId: 12,
            gameId: 88,
            gameFileId: 144,
            profileGameSaveId: 301,
            revisionTimestampUtc: new DateTime(2026, 6, 2, 23, 14, 55, DateTimeKind.Utc),
            sha256Prefix: "a1b2c3d4",
            extension: ".srm",
            cancellationToken: CancellationToken.None);

        Assert.Equal(
            "profiles/12/games/88/files/144/battery/301/20260602T231455Z-a1b2c3d4.srm",
            relativePath);

        var absolutePath = storage.GetAbsolutePath(relativePath);
        Assert.StartsWith(profileSaveRoot, absolutePath, StringComparison.Ordinal);
        Assert.True(File.Exists(absolutePath));
        Assert.Equal(bytes, await File.ReadAllBytesAsync(absolutePath));
    }

    [Fact]
    public async Task StoreRevisionAsync_keeps_multiple_immutable_revisions_for_same_logical_save()
    {
        var contentRoot = CreateTempDirectory();
        var profileSaveRoot = CreateTempDirectory();
        var storage = CreateStorage(contentRoot, profileSaveRoot);

        var firstPath = await storage.StoreRevisionAsync(
            () => new MemoryStream(new byte[] { 1 }, writable: false),
            profileId: 12,
            gameId: 88,
            gameFileId: 144,
            profileGameSaveId: 301,
            revisionTimestampUtc: new DateTime(2026, 6, 2, 23, 14, 55, DateTimeKind.Utc),
            sha256Prefix: "a1b2c3d4",
            extension: ".srm",
            cancellationToken: CancellationToken.None);

        var secondPath = await storage.StoreRevisionAsync(
            () => new MemoryStream(new byte[] { 2 }, writable: false),
            profileId: 12,
            gameId: 88,
            gameFileId: 144,
            profileGameSaveId: 301,
            revisionTimestampUtc: new DateTime(2026, 6, 2, 23, 15, 1, DateTimeKind.Utc),
            sha256Prefix: "f9e8d7c6",
            extension: ".srm",
            cancellationToken: CancellationToken.None);

        Assert.NotEqual(firstPath, secondPath);
        Assert.True(File.Exists(storage.GetAbsolutePath(firstPath)));
        Assert.True(File.Exists(storage.GetAbsolutePath(secondPath)));
    }

    [Fact]
    public void GetAbsolutePath_rejects_path_traversal_outside_profile_save_root()
    {
        var contentRoot = CreateTempDirectory();
        var profileSaveRoot = CreateTempDirectory();
        var storage = CreateStorage(contentRoot, profileSaveRoot);

        var ex = Assert.Throws<InvalidOperationException>(() => storage.GetAbsolutePath("../escape.srm"));

        Assert.Contains("Invalid storage path", ex.Message, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void Default_profile_save_root_lives_under_library_root_profile_saves()
    {
        var contentRoot = CreateTempDirectory();
        var libraryRoot = CreateTempDirectory();
        var storage = new ProfileGameSaveStorage(
            new FakeEnvironment(contentRoot),
            Options.Create(new LibraryStorageOptions { RootPath = libraryRoot }));

        var absolutePath = storage.GetAbsolutePath("profiles/12/games/88/files/144/battery/301/20260602T231455Z-a1b2c3d4.srm");

        Assert.StartsWith(Path.Combine(libraryRoot, "profile-saves"), absolutePath, StringComparison.Ordinal);
        Assert.Matches(new Regex(@"profile-saves[/\\]profiles[/\\]12"), absolutePath);
    }

    private static ProfileGameSaveStorage CreateStorage(string contentRoot, string profileSaveRoot) =>
        new(
            new FakeEnvironment(contentRoot),
            Options.Create(new LibraryStorageOptions { ProfileSaveRootPath = profileSaveRoot }));

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
