namespace games_vault.Tests;

public sealed class ReadmeAccessMatrixTests
{
    private static string ReadReadme()
    {
        var repoRoot = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "../../../../../"));
        var readmePath = Path.Combine(repoRoot, "README.md");
        return File.Exists(readmePath) ? File.ReadAllText(readmePath).Replace("\r\n", "\n") : string.Empty;
    }

    [Fact]
    public void Readme_Documents_User_Type_Feature_Matrix()
    {
        var content = ReadReadme();

        Assert.Contains("## User type feature matrix", content);
        Assert.Contains("Anonymous viewer", content);
        Assert.Contains("Player profile", content);
        Assert.Contains("Admin profile", content);
        Assert.Contains("Spectator guest", content);
        Assert.Contains("Player guest", content);
        Assert.Contains("Create normal game session", content);
        Assert.Contains("Controller input / player seat", content);
        Assert.Contains("Battery saves", content);
        Assert.Contains("Admin/library management", content);
    }
}
