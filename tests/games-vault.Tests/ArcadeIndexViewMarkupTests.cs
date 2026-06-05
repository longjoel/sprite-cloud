namespace games_vault.Tests;

public sealed class ArcadeIndexViewMarkupTests
{
    private static string ReadArcadeView()
    {
        var repoRoot = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "../../../../../"));
        var viewPath = Path.Combine(repoRoot, "Views", "Arcade", "Index.cshtml");
        return File.ReadAllText(viewPath).Replace("\r\n", "\n");
    }

    [Fact]
    public void ArcadeView_RendersRunningCabinetPreviewAttributes_AsNormalMarkup()
    {
        var content = ReadArcadeView();

        Assert.Contains("data-preview-url=\"@Url.Action(\"NosebleedPreviewVideo\", \"Home\", new { sessionId = cabinet.RuntimeSessionId })\"", content);
        Assert.DoesNotContain("$\"data-nosebleed-preview-card data-preview-url=\\\"{Url.Action(\"NosebleedPreviewVideo\", \"Home\", new { sessionId = cabinet.RuntimeSessionId })}\\\"\"", content);
    }

    [Fact]
    public void ArcadeView_UsesScalableGamePickerInsteadOfLargeGameDropdown()
    {
        var content = ReadArcadeView();

        Assert.DoesNotContain("<select class=\"form-select\" id=\"gameId\" name=\"gameId\"", content);
        Assert.Contains("Choose game", content);
        Assert.Contains("id=\"arcade-game-picker-modal\"", content);
        Assert.Contains("id=\"arcade-game-picker-search\"", content);
        Assert.Contains("id=\"arcade-game-picker-system\"", content);
        Assert.Contains("id=\"arcade-game-picker-players\"", content);
        Assert.Contains("id=\"arcade-game-picker-sort\"", content);
        Assert.Contains("id=\"arcade-selected-game-id\"", content);
        Assert.Contains("arcade-game-picker.js", content);
    }
}
