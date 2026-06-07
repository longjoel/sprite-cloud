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
    public void AdminView_DefinesSingleBackendHub()
    {
        var content = ReadAdminView();

        Assert.Contains("id=\"admin-backend-hero\"", content);
        Assert.Contains("Administrative backend", content);
        Assert.Contains("One place for everything behind the curtain.", content);
        Assert.Contains("id=\"admin-backend-sections\"", content);
    }

    [Fact]
    public void AdminView_LinksAllBackendDestinations()
    {
        var content = ReadAdminView();

        Assert.Contains("asp-controller=\"Games\" asp-action=\"Index\">Manage games</a>", content);
        Assert.Contains("asp-controller=\"GameFiles\" asp-action=\"Index\">Game files</a>", content);
        Assert.Contains("asp-controller=\"Sources\" asp-action=\"Index\">Sources</a>", content);
        Assert.Contains("asp-controller=\"Downloads\" asp-action=\"Index\">Downloads</a>", content);
        Assert.Contains("asp-controller=\"Jobs\" asp-action=\"Index\">Jobs</a>", content);
        Assert.Contains("href=\"#admin-stream-settings\">Stream settings</a>", content);
        Assert.Contains("asp-controller=\"Profiles\" asp-action=\"Index\">Profiles</a>", content);
        Assert.Contains("asp-controller=\"Profiles\" asp-action=\"Invites\">Invites</a>", content);
        Assert.Contains("asp-controller=\"SystemFiles\" asp-action=\"Index\">System files</a>", content);
        Assert.Contains("asp-controller=\"SystemCoreMappings\" asp-action=\"Index\">Core mappings</a>", content);
    }

    [Fact]
    public void AdminView_HostsStreamSettingsForm()
    {
        var content = ReadAdminView();

        Assert.Contains("id=\"admin-stream-settings\"", content);
        Assert.Contains("Stream settings", content);
        Assert.Contains("asp-action=\"SaveStreamSettings\"", content);
        Assert.Contains("name=\"PreferredVideoTransport\"", content);
        Assert.Contains("value=\"websocket\"", content);
        Assert.Contains("name=\"WebSocketVideoCompression\"", content);
        Assert.Contains("value=\"raw\"", content);
        Assert.Contains("name=\"WebRtcVideoEncoder\"", content);
        Assert.Contains("vp8_vaapi", content);
        Assert.Contains("name=\"WebRtcVideoEncoderArgs\"", content);
        Assert.Contains("name=\"FfmpegBinary\"", content);
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
