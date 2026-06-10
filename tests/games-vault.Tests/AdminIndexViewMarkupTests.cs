namespace games_vault.Tests;

public sealed class AdminIndexViewMarkupTests
{
    private static string ReadAdminView()
    {
        var repoRoot = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "../../../../../"));
        var viewPath = Path.Combine(repoRoot, "Views", "Admin", "Index.cshtml");
        return File.ReadAllText(viewPath).Replace("\r\n", "\n");
    }

    [Fact]
    public void AdminView_DefinesUnifiedDashboard()
    {
        var content = ReadAdminView();

        Assert.Contains("Admin", content);
        Assert.Contains("id=\"admin-stream-settings\"", content);
        Assert.Contains("id=\"admin-nosebleed-runtime\"", content);
        Assert.Contains("id=\"admin-setup\"", content);
    }

    [Fact]
    public void AdminView_QuickNavIncludesSetup()
    {
        var content = ReadAdminView();

        Assert.Contains("href=\"#admin-setup\">Setup</a>", content);
    }

    [Fact]
    public void AdminView_LinksAllBackendDestinations()
    {
        var content = ReadAdminView();

        Assert.Contains("asp-controller=\"Profiles\" asp-action=\"Index\">Profiles</a>", content);
        Assert.Contains("asp-controller=\"Profiles\" asp-action=\"Invites\">Invites</a>", content);
        Assert.Contains("asp-controller=\"SystemFiles\" asp-action=\"Index\">System files</a>", content);
        Assert.Contains("asp-controller=\"GameFiles\" asp-action=\"Index\">Game files</a>", content);
    }

    [Fact]
    public void AdminView_HostsStreamSettingsForm()
    {
        var content = ReadAdminView();

        Assert.Contains("id=\"admin-stream-settings\"", content);
        Assert.Contains("Stream settings", content);
        Assert.Contains("asp-action=\"SaveStreamSettings\"", content);
        Assert.Contains("name=\"PreferredVideoTransport\"", content);
        Assert.Contains("Save stream settings", content);
    }

    [Fact]
    public void AdminView_HostsNosebleedRuntimeSurveyAndTerminateActions()
    {
        var content = ReadAdminView();

        Assert.Contains("id=\"admin-nosebleed-runtime\"", content);
        Assert.Contains("Nosebleed process survey", content);
        Assert.Contains("@foreach (var process in Model.NosebleedRuntimeProcesses)", content);
        Assert.Contains("CPU / Mem", content);
        Assert.Contains("FormatBytes(process.WorkingSetBytes.Value)", content);
        Assert.Contains("asp-action=\"StopNosebleedSession\"", content);
        Assert.Contains("asp-action=\"KillNosebleedProcess\"", content);
        Assert.Contains(">Terminate</button>", content);
    }

}
