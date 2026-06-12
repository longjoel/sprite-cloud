namespace games_vault.Tests;

public sealed class HomeIndexViewMarkupTests
{
    private static string ReadHomeView()
    {
        var repoRoot = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "../../../../../"));
        var viewPath = Path.Combine(repoRoot, "Views", "Home", "Index.cshtml");
        return File.ReadAllText(viewPath).Replace("\r\n", "\n");
    }

    [Fact]
    public void HomeView_DefinesQuickResumeSection_ForContinuePlayingAndActiveMachines()
    {
        var content = ReadHomeView();

        Assert.Contains("Continue playing", content);
        Assert.Contains("Sign in / join", content);
    }

    [Fact]
    public void HomeView_DefinesActiveMachinesSection()
    {
        var content = ReadHomeView();

        Assert.Contains("id=\"home-active-machines\"", content);
        Assert.Contains(">Active machines<", content);
        Assert.Contains("var arcadeSessions = Model.ActiveArcadeCabinets", content);
        Assert.Contains("No active machines right now.", content);
    }

    [Fact]
    public void HomeView_UsesRoomCodeLinks_ForActiveLibrarySessions()
    {
        var content = ReadHomeView();

        Assert.Contains("!string.IsNullOrWhiteSpace(session.RoomCode)", content);
        Assert.Contains("asp-route-code=\"@session.RoomCode\"", content);
    }

    [Fact]
    public void HomeView_RendersSessionPreviewAttributes_AsNormalMarkup()
    {
        var content = ReadHomeView();

        Assert.Contains("data-preview-url=\"@Url.Action(\"NosebleedPreviewVideo\", \"Home\", new { sessionId = session.SessionId })\"", content);
        Assert.DoesNotContain("$\"data-nosebleed-preview-card data-preview-url=\\\"{Url.Action(\"NosebleedPreviewVideo\", \"Home\", new { sessionId = session.SessionId })}\\\"\"", content);
    }

    [Fact]
    public void HomeView_Renders_GameArt_WhenAvailable_WithGeneratedFallback()
    {
        var content = ReadHomeView();

        Assert.Contains("var previewImage = !string.IsNullOrWhiteSpace(game.PreviewImagePath) ? game.PreviewImagePath", content);
        Assert.Contains("!string.IsNullOrWhiteSpace(game.ScreenshotImagePath) ? game.ScreenshotImagePath", content);
        Assert.Contains("game.CoverImagePath;", content);
        Assert.Contains("var previewImage = !string.IsNullOrWhiteSpace(session.ScreenshotImagePath) ? session.ScreenshotImagePath : session.CoverImagePath;", content);
        Assert.Contains("<img class=\"games-card-preview-image\" src=\"@previewImage\" alt=\"\" loading=\"lazy\" />", content);
        Assert.Contains("<div class=\"games-card-preview-text games-card-preview-text-sm\">@game.GameName</div>", content);
        Assert.Contains("<div class=\"games-card-preview-text games-card-preview-text-sm\">@session.GameName</div>", content);
    }

    [Fact]
    public void HomeView_DoesNotRender_GamesLibraryPreviewSection()
    {
        var content = ReadHomeView();

        Assert.DoesNotContain("id=\"home-games-library\"", content);
        Assert.DoesNotContain(">Games library<", content);
    }

    [Fact]
    public void HomeView_DoesNotRender_AdminWorkspaceGate()
    {
        var content = ReadHomeView();

        Assert.DoesNotContain("id=\"home-admin-workspace\"", content);
        Assert.DoesNotContain("Admin workspace", content);
    }

    [Fact]
    public void HomeView_DoesNotRender_SetupSection()
    {
        var content = ReadHomeView();

        Assert.DoesNotContain("Setup", content);
        Assert.DoesNotContain("admin-setup", content);
        Assert.DoesNotContain("LibretroDatabaseInstalled", content);
    }

    [Fact]
    public void HomeView_DoesNotRender_LibrarySearchAndSidebarCards()
    {
        var content = ReadHomeView();

        Assert.DoesNotContain("id=\"home-library-search\"", content);
        Assert.DoesNotContain("id=\"home-sign-in-card\"", content);
        Assert.DoesNotContain("id=\"home-library-summary-card\"", content);
    }

    [Fact]
    public void HomeView_RemovesDuplicateDashboardBands_FromOperationsSection()
    {
        var content = ReadHomeView();

        Assert.DoesNotContain("Active session overview", content);
        Assert.DoesNotContain("Arcade activity", content);
        Assert.DoesNotContain("Library sessions", content);
        Assert.DoesNotContain("id=\"home-admin-shortcut-card\"", content);
        Assert.DoesNotContain("id=\"home-operations\"", content);
        Assert.DoesNotContain(">Recent sessions<", content);
        Assert.DoesNotContain(">Active profiles<", content);
        Assert.DoesNotContain(">Top played games<", content);
    }

    [Fact]
    public void HomeView_DoesNotRender_AdminRuntimeSurvey()
    {
        var content = ReadHomeView();

        Assert.DoesNotContain("id=\"home-admin-runtime\"", content);
        Assert.DoesNotContain("Nosebleed runtime processes", content);
        Assert.DoesNotContain("@foreach (var process in Model.NosebleedRuntimeProcesses)", content);
        Assert.DoesNotContain("asp-action=\"KillNosebleedProcess\"", content);
    }

    [Fact]
    public void HomeView_Removes_WebPlayerSetupLanguage()
    {
        var content = ReadHomeView();

        Assert.DoesNotContain("Install RetroArch web player", content);
        Assert.DoesNotContain("StartWebPlayerInstall", content);
        Assert.DoesNotContain("Use the web player to test cores.", content);
        Assert.DoesNotContain("Web player setup", content);
    }
}
