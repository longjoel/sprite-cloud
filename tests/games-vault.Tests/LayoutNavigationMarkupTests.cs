namespace games_vault.Tests;

public sealed class LayoutNavigationMarkupTests
{
    private static string ReadLayout()
    {
        var repoRoot = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "../../../../../"));
        var layoutPath = Path.Combine(repoRoot, "Views", "Shared", "_Layout.cshtml");
        return File.ReadAllText(layoutPath).Replace("\r\n", "\n");
    }

    [Fact]
    public void Layout_UsesSignedInGate_ForGamesTab()
    {
        var content = ReadLayout();

        Assert.Contains("var isSignedIn = ViewData[\"CurrentProfileId\"] is int;", content);
        Assert.Contains("@if (isSignedIn)", content);
        Assert.Contains("asp-controller=\"Games\" asp-action=\"Index\">Games</a>", content);
    }

    [Fact]
    public void Layout_UsesSingleAdminBackendLink_InsteadOfDropdown()
    {
        var content = ReadLayout();

        Assert.Contains("asp-controller=\"Admin\" asp-action=\"Index\">Admin</a>", content);
        Assert.DoesNotContain("id=\"admin-nav-dropdown\"", content);
        Assert.DoesNotContain("dropdown-menu", content);
        Assert.DoesNotContain("asp-controller=\"GameFiles\" asp-action=\"Index\">Game Files</a>", content);
        Assert.DoesNotContain("asp-controller=\"SystemFiles\" asp-action=\"Index\">System Files</a>", content);
        Assert.DoesNotContain("asp-controller=\"Home\" asp-action=\"Index\" asp-fragment=\"home-admin-runtime\"", content);
    }

    [Fact]
    public void Layout_KeepsHomeAndArcadeTopLevelTabs()
    {
        var content = ReadLayout();

        Assert.Contains("asp-controller=\"Home\" asp-action=\"Index\">Home</a>", content);
        Assert.Contains("asp-controller=\"Arcade\" asp-action=\"Index\">Arcade</a>", content);
    }

    [Fact]
    public void Layout_DefinesSiteWarningCookieBanner()
    {
        var content = ReadLayout();

        Assert.Contains("id=\"site-warning-banner\"", content);
        Assert.Contains("Warning / cookie notice", content);
        Assert.Contains("stores cookies on your computer", content);
        Assert.Contains("causes cancer in the state of California", content);
        Assert.Contains("id=\"site-warning-accept\"", content);
        Assert.Contains("id=\"site-warning-dismiss\"", content);
    }
}
