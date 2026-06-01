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
}
