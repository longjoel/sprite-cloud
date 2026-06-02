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
    public void Layout_UsesAdminDropdown_InsteadOfTopLevelAdminLinks()
    {
        var content = ReadLayout();

        Assert.Contains("id=\"admin-nav-dropdown\"", content);
        Assert.Contains(">Admin</a>", content);
        Assert.Contains("dropdown-menu", content);
        Assert.DoesNotContain("asp-controller=\"Profiles\" asp-action=\"Index\">Profiles</a>\n                        </li>\n                        <li class=\"nav-item\">", content);
    }

    [Fact]
    public void Layout_AdminDropdownContainsExpectedEntries()
    {
        var content = ReadLayout();

        Assert.Contains("asp-controller=\"Profiles\" asp-action=\"Index\">Profiles</a>", content);
        Assert.Contains("asp-controller=\"GameFiles\" asp-action=\"Index\">Game Files</a>", content);
        Assert.Contains("asp-controller=\"SystemFiles\" asp-action=\"Index\">System Files</a>", content);
        Assert.Contains("asp-controller=\"SystemCoreMappings\" asp-action=\"Index\">Core Mappings</a>", content);
        Assert.Contains("asp-controller=\"Profiles\" asp-action=\"Invites\">Profile Invites</a>", content);
        Assert.Contains("asp-controller=\"Sources\" asp-action=\"Index\">Sources</a>", content);
        Assert.Contains("asp-controller=\"Jobs\" asp-action=\"Index\">Jobs</a>", content);
        Assert.Contains("asp-controller=\"Downloads\" asp-action=\"Index\">Downloads</a>", content);
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
