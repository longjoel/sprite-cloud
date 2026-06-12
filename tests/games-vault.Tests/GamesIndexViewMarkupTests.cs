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
        Assert.Contains("<div class=\"games-card-footer-actions\">", bankContent);
        Assert.Contains("@(isGuest ? \"Watch\" : \"Play\")", bankContent);
    }

    [Fact]
    public void GamesBank_Admin_Card_Actions_Are_Hidden_From_Non_Admins()
    {
        var bankContent = ReadGamesBankView();

        Assert.Contains("var canManageLibrary = Model.CanManageLibrary;", bankContent);
        Assert.Contains("@if (canManageLibrary)", bankContent);
        Assert.Contains("asp-action=\"Edit\"", bankContent);
        Assert.DoesNotContain(">Open details</a>", bankContent);
        Assert.DoesNotContain("Quick details", bankContent);
        Assert.DoesNotContain("Edit inline", bankContent);
        Assert.DoesNotContain("btn btn-outline-danger", bankContent);
        Assert.DoesNotContain(">Delete</a>", bankContent);
    }

    [Fact]
    public void GamesBank_Renders_In_Progress_Room_Join_Buttons()
    {
        var bankContent = ReadGamesBankView();
        var indexContent = ReadGamesIndexView();
        var repoRoot = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "../../../../../"));
        var bankViewModel = File.ReadAllText(Path.Combine(repoRoot, "Models", "ViewModels", "GamesBankViewModel.cs")).Replace("\r\n", "\n");
        var controllerContent = File.ReadAllText(Path.Combine(repoRoot, "Controllers", "GamesController.cs")).Replace("\r\n", "\n");
        var sessionContent = File.ReadAllText(Path.Combine(repoRoot, "Controllers", "SessionController.cs")).Replace("\r\n", "\n");

        Assert.Contains("public sealed record GamesLibraryActiveRoomOption(string Code, string PlayerName);", bankViewModel);
        Assert.Contains("ActiveRoomsByGameId = Model.ActiveRoomsByGameId", indexContent);
        Assert.Contains("ActiveRoomsByGameId = activeRoomsByGameId", controllerContent);
        Assert.Contains("nosebleedSessions.Cleanup();", sessionContent);
        Assert.Contains("nosebleedSessions.GetSessions()", sessionContent);
        Assert.Contains("x.NosebleedSessionId == sessionId", sessionContent);
        Assert.Contains("NosebleedSessionId == sessionId && x.Status == GamePlayRoomStatus.Active", sessionContent);
        Assert.Contains("var roomId = await _db.GamePlayRooms", sessionContent);
        Assert.Contains("x.Status == GamePlayRoomStatus.Active", sessionContent);
        Assert.Contains("roomService.TouchRoomParticipantSessionAsync", sessionContent);
        Assert.Contains("var activeRooms = Model.ActiveRoomsByGameId.TryGetValue(game.Id, out var rooms)", bankContent);
        Assert.Contains("games-card-room-row", bankContent);
        Assert.Contains("asp-route-code=\"@room.Code\"", bankContent);
        Assert.Contains("<span class=\"games-card-room-code\">@room.Code</span>", bankContent);
        Assert.Contains("<span class=\"games-card-room-user\">@room.PlayerName</span>", bankContent);
    }

    [Fact]
    public void GamesBank_Renders_GameArt_WhenAvailable_WithGeneratedFallback()
    {
        var bankContent = ReadGamesBankView();

        Assert.Contains("var previewImage = !string.IsNullOrWhiteSpace(game.ScreenshotImagePath) ? game.ScreenshotImagePath : game.CoverImagePath;", bankContent);
        Assert.Contains("@if (!string.IsNullOrWhiteSpace(previewImage))", bankContent);
        Assert.Contains("<img class=\"games-card-preview-image\" src=\"@previewImage\" alt=\"\" loading=\"lazy\" />", bankContent);
        Assert.Contains("<div class=\"games-card-preview-text\">@game.Name</div>", bankContent);
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
