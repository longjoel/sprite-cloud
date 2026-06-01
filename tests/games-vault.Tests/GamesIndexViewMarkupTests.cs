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
    public void GamesViews_Remove_BatchFeatureMarkup()
    {
        var indexContent = ReadGamesIndexView();
        var bankContent = ReadGamesBankView();

        Assert.DoesNotContain("games-batch-column", indexContent);
        Assert.DoesNotContain("wireBulkSelection", indexContent);
        Assert.DoesNotContain("id=\"games-bulk-form\"", bankContent);
        Assert.DoesNotContain("Add to batch", bankContent);
        Assert.DoesNotContain("In batch", bankContent);
        Assert.DoesNotContain("Select page", bankContent);
    }
}
