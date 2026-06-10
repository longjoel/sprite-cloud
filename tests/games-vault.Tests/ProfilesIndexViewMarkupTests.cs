namespace games_vault.Tests;

public sealed class ProfilesIndexViewMarkupTests
{
    private static string ReadProfilesView()
    {
        var repoRoot = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "../../../../../"));
        var viewPath = Path.Combine(repoRoot, "Views", "Profiles", "Index.cshtml");
        return File.ReadAllText(viewPath).Replace("\r\n", "\n");
    }

    [Fact]
    public void ProfilesView_DefinesHeroAndSignInCards()
    {
        var content = ReadProfilesView();

        Assert.Contains("id=\"profiles-hero\"", content);
        Assert.Contains("id=\"profiles-sign-in-required-card\"", content);
        Assert.Contains(">Sign in<", content);
        Assert.Contains(">Browse first<", content);
    }

    [Fact]
    public void ProfilesView_ShowsSignInCardOnlyForViewers()
    {
        var content = ReadProfilesView();

        Assert.Contains("@if (isViewer && Model.Profiles.Count > 0)", content);
        Assert.Contains("id=\"profiles-sign-in-card\"", content);
        Assert.Contains(">Existing profile<", content);
        Assert.Contains("Persistent cookie", content);
    }

    [Fact]
    public void ProfilesView_DefinesSignedInStateCard()
    {
        var content = ReadProfilesView();

        Assert.Contains("id=\"profiles-current-profile-card\"", content);
        Assert.Contains(">View full profile<", content);
        Assert.Contains(">Sign out<", content);
    }

    [Fact]
    public void ProfilesView_DefinesSignedInDashboardModules()
    {
        var content = ReadProfilesView();

        Assert.Contains("id=\"profiles-dashboard\"", content);
        Assert.Contains("id=\"profiles-dashboard-top-games\"", content);
        Assert.Contains("id=\"profiles-dashboard-recent-sessions\"", content);
        Assert.Contains(">Signed-in player dashboard<", content);
    }

    [Fact]
    public void ProfilesView_ShowsJoinCardOnlyForViewers()
    {
        var content = ReadProfilesView();

        Assert.Contains("@if (isViewer)", content);
        Assert.Contains("id=\"profiles-join-card\"", content);
        Assert.Contains(">Create a player profile<", content);
        Assert.Contains("asp-action=\"Create\"", content);
    }
}
