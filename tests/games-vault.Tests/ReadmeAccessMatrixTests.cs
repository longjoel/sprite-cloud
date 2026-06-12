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

        Assert.Contains("## User roles", content);
        Assert.Contains("Anonymous", content);
        Assert.Contains("Player", content);
        Assert.Contains("Admin", content);
        Assert.Contains("Guest (share link)", content);
        Assert.Contains("Browse", content);
        Assert.Contains("Watch", content);
        Assert.Contains("Play", content);
        Assert.Contains("Chat", content);
        Assert.Contains("Save", content);
    }
}
