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

    [Fact]
    public void BrowsePane_Renders_Inviting_Library_Search_Filter_Sort_And_Group_Controls()
    {
        var content = ReadGamesIndexView();

        Assert.Contains("Browse your library", content);
        Assert.Contains("Search your collection", content);
        Assert.Contains("Search games, systems, files, CRC…", content);
        Assert.Contains("id=\"games-system-filter\"", content);
        Assert.Contains("id=\"games-players-filter\"", content);
        Assert.Contains("id=\"games-sort\"", content);
        Assert.Contains("id=\"games-group\"", content);
        Assert.Contains("id=\"games-playing-now\"", content);
        Assert.Contains("What's being played right now", content);
        Assert.Contains("Most played all time", content);
        Assert.Contains("Most played this week", content);
    }

    [Fact]
    public void GamesBank_Renders_Group_Headings_And_Filtered_Empty_States()
    {
        var bankContent = ReadGamesBankView();

        Assert.Contains("games-library-group-heading", bankContent);
        Assert.Contains("groupSection.Label", bankContent);
        Assert.Contains("Nothing is being played right now.", bankContent);
        Assert.Contains("No games match the current filters.", bankContent);
        Assert.Contains("Clear filters", bankContent);
    }

    [Fact]
    public void GamesBank_Pagination_Preserves_Browse_Query_Parameters()
    {
        var bankContent = ReadGamesBankView();

        Assert.Contains("asp-route-system=\"@Model.Browse.System\"", bankContent);
        Assert.Contains("asp-route-players=\"@Model.Browse.Players\"", bankContent);
        Assert.Contains("asp-route-playingNow=\"@(Model.Browse.PlayingNow ? true : (bool?)null)\"", bankContent);
        Assert.Contains("asp-route-sort=\"@Model.Browse.Sort\"", bankContent);
        Assert.Contains("asp-route-group=\"@Model.Browse.Group\"", bankContent);
    }

    [Fact]
    public void Games_Index_Javascript_Updates_Url_And_Bank_For_All_Browse_Controls()
    {
        var content = ReadGamesIndexView();

        Assert.Contains("games-browse-control", content);
        Assert.Contains("history.replaceState", content);
        Assert.Contains("writeParams(qs, params)", content);
        Assert.Contains("system: data.get('system')", content);
        Assert.Contains("players: data.get('players')", content);
        Assert.Contains("playingNow: data.get('playingNow')", content);
        Assert.Contains("sort: data.get('sort')", content);
        Assert.Contains("group: data.get('group')", content);
        Assert.Contains("browseControls.forEach", content);
    }
}
