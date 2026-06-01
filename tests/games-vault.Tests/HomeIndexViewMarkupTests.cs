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
    public void HomeView_DefinesHeroSection_ForWelcomeAndPrimaryCtas()
    {
        var content = ReadHomeView();

        Assert.Contains("id=\"home-hero\"", content);
        Assert.Contains("Sign in / join", content);
    }

    [Fact]
    public void HomeView_DefinesActiveMachinesSection()
    {
        var content = ReadHomeView();

        Assert.Contains("id=\"home-active-machines\"", content);
        Assert.Contains(">Active machines<", content);
        Assert.Contains("var visibleActiveSessions = featuredSession is null", content);
        Assert.Contains("!string.Equals(x.SessionId, featuredSession.SessionId, StringComparison.OrdinalIgnoreCase)", content);
        Assert.Contains("The featured machine above is the only active one right now.", content);
    }

    [Fact]
    public void HomeView_RendersFeaturedPreviewAttributes_AsNormalMarkup()
    {
        var content = ReadHomeView();

        Assert.Contains("data-preview-url=\"@Url.Action(\"NosebleedPreviewVideo\", \"Home\", new { sessionId = featuredSession.SessionId })\"", content);
        Assert.DoesNotContain("$\"data-nosebleed-preview-card data-preview-url=\\\"{Url.Action(\"NosebleedPreviewVideo\", \"Home\", new { sessionId = featuredSession.SessionId })}\\\"\"", content);
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
    public void HomeView_HidesSetupBranchWhenDashboardIsShown()
    {
        var content = ReadHomeView();

        Assert.Contains("<div class=\"row\" hidden=\"@(Model.ShowDashboard)\">", content);
        Assert.DoesNotContain("\n@else\n{", content);
        Assert.DoesNotContain("\n} else {", content);
        Assert.DoesNotContain("\n}\nelse\n{", content);
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
    public void HomeView_MainHomepageFlow_StopsAfterActiveMachines()
    {
        var content = ReadHomeView();

        var activeMachinesIndex = content.IndexOf("id=\"home-active-machines\"", StringComparison.Ordinal);
        var setupIndex = content.IndexOf("<div class=\"row\" hidden=\"@(Model.ShowDashboard)\">", StringComparison.Ordinal);

        Assert.True(activeMachinesIndex >= 0, "Expected active machines section to exist.");
        Assert.True(setupIndex > activeMachinesIndex, "Expected the dashboard flow to stop after active machines before the hidden setup branch begins.");
    }
}
