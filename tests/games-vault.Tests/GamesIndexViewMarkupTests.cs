namespace games_vault.Tests;

public sealed class GamesIndexViewMarkupTests
{
    private static string ReadGamesIndexView()
    {
        var repoRoot = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "../../../../../"));
        var viewPath = Path.Combine(repoRoot, "Views", "Games", "Index.cshtml");
        return File.ReadAllText(viewPath).Replace("\r\n", "\n");
    }

    private static string ReadGamesBankView()
    {
        var repoRoot = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "../../../../../"));
        var viewPath = Path.Combine(repoRoot, "Views", "Games", "_GamesBank.cshtml");
        return File.ReadAllText(viewPath).Replace("\r\n", "\n");
    }

    [Fact]
    public void AddPane_IsSiblingOfBrowsePane_NotNestedInsideBrowseColumns()
    {
        var content = ReadGamesIndexView();

        var expectedSnippet =
            "            <div class=\"row g-3\">\n" +
            "    <div class=\"col-12 games-bank-column\">\n" +
            "        <div id=\"games-bank-container\">\n" +
            "            <partial name=\"_GamesBank\" model=\"bankModel\" />\n" +
            "        </div>\n" +
    "    </div>\n" +
            "</div>\n" +
            "        </div>\n\n" +
            "        <div class=\"tab-pane fade @(addTabActive ? \"show active\" : \"\")\" id=\"games-add-pane\"";

        Assert.Contains(expectedSnippet, content);
    }

    [Fact]
    public void Header_DoesNotDuplicate_SurfaceSwitchButtons_AboveTabs()
    {
        var content = ReadGamesIndexView();

        Assert.DoesNotContain("games-surface-switch", content);
        Assert.Contains("id=\"games-page-tabs\"", content);
    }

    [Fact]
    public void GamesBank_Consolidates_Card_Actions_To_Bottom_Buttons()
    {
        var bankContent = ReadGamesBankView();
        var detailsContent = File.ReadAllText(Path.Combine(Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "../../../../../")), "Views", "Games", "Details.cshtml")).Replace("\r\n", "\n");

        Assert.DoesNotContain("asp-action=\"Play\"", detailsContent);
        Assert.DoesNotContain("Play in browser", detailsContent);
        Assert.DoesNotContain("asp-action=\"Play\"", bankContent);
        Assert.DoesNotContain(">Browser<", bankContent);
        Assert.DoesNotContain("dropdown-toggle", bankContent);
        Assert.DoesNotContain("dropdown-menu", bankContent);
        Assert.DoesNotContain(">Actions<", bankContent);
        Assert.Contains("<div class=\"games-primary-actions d-flex flex-wrap gap-2 mt-auto\">", bankContent);
        Assert.Contains(">Play</a>", bankContent);
        Assert.Contains(">Open details</a>", bankContent);
        Assert.Contains("Quick details", bankContent);
        Assert.Contains("Edit inline", bankContent);
        Assert.Contains("btn btn-outline-danger", bankContent);
        Assert.Contains(">Delete</a>", bankContent);
    }
}
