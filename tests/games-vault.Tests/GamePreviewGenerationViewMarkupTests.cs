namespace games_vault.Tests;

public sealed class GameEditViewMarkupTests
{
    private static string ReadEditView()
    {
        var repoRoot = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "../../../../../"));
        var viewPath = Path.Combine(repoRoot, "Views", "Games", "Edit.cshtml");
        return File.ReadAllText(viewPath).Replace("\r\n", "\n");
    }

    [Fact]
    public void EditView_HasGeneratePreviewButton()
    {
        var content = ReadEditView();

        Assert.Contains("Generate preview", content);
        Assert.Contains("asp-action=\"GeneratePreview\"", content);
    }

    [Fact]
    public void EditView_HasRegeneratePreviewButton()
    {
        var content = ReadEditView();

        Assert.Contains("Regenerate preview", content);
        Assert.Contains("name=\"force\" value=\"true\"", content);
    }

    [Fact]
    public void EditView_ShowsPreviewImageWhenPresent()
    {
        var content = ReadEditView();

        Assert.Contains("Model.PreviewImagePath", content);
        Assert.Contains("Preview", content);
    }

    [Fact]
    public void EditView_HasPreviewHeading()
    {
        var content = ReadEditView();

        Assert.Contains("Preview", content);
        Assert.Contains("TempData[\"Message\"]", content);
    }

    [Fact]
    public void EditView_IncludesGameForm()
    {
        var content = ReadEditView();

        Assert.Contains("asp-action=\"Edit\"", content);
        Assert.Contains("asp-for=\"SystemName\"", content);
        Assert.Contains("asp-for=\"Name\"", content);
        Assert.Contains("Save", content);
    }
}

public sealed class GameCardPreviewFallbackTests
{
    private static string ReadGamesBankView()
    {
        var repoRoot = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "../../../../../"));
        var viewPath = Path.Combine(repoRoot, "Views", "Games", "_GamesBank.cshtml");
        return File.ReadAllText(viewPath).Replace("\r\n", "\n");
    }

    private static string ReadHomeIndexView()
    {
        var repoRoot = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "../../../../../"));
        var viewPath = Path.Combine(repoRoot, "Views", "Home", "Index.cshtml");
        return File.ReadAllText(viewPath).Replace("\r\n", "\n");
    }

    [Fact]
    public void GamesBank_PrefersPreviewImagePath()
    {
        var content = ReadGamesBankView();

        // The fallback chain should check PreviewImagePath first
        Assert.Contains("game.PreviewImagePath", content);
        Assert.Contains("game.ScreenshotImagePath", content);
        Assert.Contains("game.CoverImagePath", content);
        // PreviewImagePath should appear before ScreenshotImagePath
        var previewIdx = content.IndexOf("PreviewImagePath", StringComparison.Ordinal);
        var screenshotIdx = content.IndexOf("ScreenshotImagePath", StringComparison.Ordinal);
        Assert.True(previewIdx < screenshotIdx, "PreviewImagePath should be checked before ScreenshotImagePath");
    }

    [Fact]
    public void HomeIndex_PrefersPreviewImagePath()
    {
        var content = ReadHomeIndexView();

        Assert.Contains("game.PreviewImagePath", content);
        Assert.Contains("game.ScreenshotImagePath", content);
        Assert.Contains("game.CoverImagePath", content);

        var previewIdx = content.IndexOf("PreviewImagePath", StringComparison.Ordinal);
        var screenshotIdx = content.IndexOf("ScreenshotImagePath", StringComparison.Ordinal);
        Assert.True(previewIdx < screenshotIdx, "PreviewImagePath should be checked before ScreenshotImagePath");
    }
}
