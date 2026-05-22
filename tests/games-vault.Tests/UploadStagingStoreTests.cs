using games_vault.Libretro.Import;
using Microsoft.AspNetCore.Hosting;
using Microsoft.Extensions.FileProviders;
using Microsoft.Extensions.Options;

namespace games_vault.Tests;

public sealed class UploadStagingStoreTests
{
    [Fact]
    public void CreateStagingDirectoryUsesConfiguredWritableRoot()
    {
        var contentRoot = CreateTempDirectory();
        var stagingRoot = CreateTempDirectory();
        var store = new UploadStagingStore(
            new FakeEnvironment(contentRoot),
            Options.Create(new LibraryStorageOptions
            {
                UploadStagingRootPath = stagingRoot
            }));

        var stagingDirectory = store.CreateStagingDirectory();

        Assert.StartsWith(
            Path.TrimEndingDirectorySeparator(Path.GetFullPath(stagingRoot)) + Path.DirectorySeparatorChar,
            Path.GetFullPath(stagingDirectory),
            StringComparison.Ordinal);
        Assert.True(Directory.Exists(stagingDirectory));
        Assert.True(store.IsWithinRoot(stagingDirectory));
    }

    [Fact]
    public void RelativeStagingRootIsResolvedUnderContentRootForDevelopmentFallback()
    {
        var contentRoot = CreateTempDirectory();
        var store = new UploadStagingStore(
            new FakeEnvironment(contentRoot),
            Options.Create(new LibraryStorageOptions
            {
                UploadStagingRootPath = "App_Data/uploads"
            }));

        var stagingDirectory = store.CreateStagingDirectory();
        var expectedRoot = Path.Combine(contentRoot, "App_Data", "uploads");

        Assert.StartsWith(
            Path.TrimEndingDirectorySeparator(Path.GetFullPath(expectedRoot)) + Path.DirectorySeparatorChar,
            Path.GetFullPath(stagingDirectory),
            StringComparison.Ordinal);
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
