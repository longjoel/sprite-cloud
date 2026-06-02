namespace games_vault.Tests;

public sealed class SiteJsMarkupTests
{
    private static string ReadSiteJs()
    {
        var repoRoot = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "../../../../../"));
        var scriptPath = Path.Combine(repoRoot, "wwwroot", "js", "site.js");
        return File.ReadAllText(scriptPath).Replace("\r\n", "\n");
    }

    [Fact]
    public void SiteJs_PersistsWarningBannerAcknowledgementInLocalStorage()
    {
        var content = ReadSiteJs();

        Assert.Contains("gv.siteWarningAcknowledged", content);
        Assert.Contains("site-warning-banner", content);
        Assert.Contains("site-warning-accept", content);
        Assert.Contains("site-warning-dismiss", content);
        Assert.Contains("window.localStorage", content);
        Assert.Contains("site-warning-visible", content);
    }
}
