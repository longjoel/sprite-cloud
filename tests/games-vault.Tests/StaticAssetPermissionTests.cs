namespace games_vault.Tests;

public sealed class StaticAssetPermissionTests
{
    [Theory]
    [InlineData("wwwroot/js/arcade-game-picker.js")]
    public void StaticAssetsReferencedWithAspAppendVersion_AreWorldReadable(string relativePath)
    {
        var repoRoot = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "../../../../../"));
        var assetPath = Path.Combine(repoRoot, relativePath.Replace('/', Path.DirectorySeparatorChar));

        Assert.True(File.Exists(assetPath), $"Expected static asset to exist: {relativePath}");

        var mode = File.GetUnixFileMode(assetPath);
        Assert.True(
            mode.HasFlag(UnixFileMode.OtherRead),
            $"{relativePath} must be world-readable because ASP.NET asp-append-version opens it as the games-vault service user.");
    }
}
