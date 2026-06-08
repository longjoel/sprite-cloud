namespace games_vault.Tests;

public sealed class PlayServerMarkupTests
{
    private static readonly string[] Partials = [
        "_PlayerHUD.cshtml",
        "_ArcadeSeatPanel.cshtml",
        "_ConnectionDiagnostics.cshtml",
        "_TouchLayout.cshtml",
        "_SessionConfig.cshtml",
        "_InviteLinks.cshtml",
        "_BatterySaveModal.cshtml",
        "_RoomChat.cshtml",
        "_SessionGrid.cshtml",
    ];

    private static readonly string[] JsFiles = [
        "room-utils.js",
        "playserver-extras.js",
    ];

    private static string ReadPlayServerView()
    {
        var repoRoot = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "../../../../../"));
        var viewsDir = Path.Combine(repoRoot, "Views", "Games");
        var cssPath = Path.Combine(repoRoot, "wwwroot", "css", "playserver.css");
        var jsDir = Path.Combine(repoRoot, "wwwroot", "js", "nosebleed-player");
        var sb = new System.Text.StringBuilder();
        sb.AppendLine(File.ReadAllText(Path.Combine(viewsDir, "PlayServer.cshtml")).Replace("\r\n", "\n"));
        foreach (var partial in Partials)
        {
            var path = Path.Combine(viewsDir, partial);
            if (File.Exists(path))
            {
                sb.AppendLine();
                sb.AppendLine(File.ReadAllText(path).Replace("\r\n", "\n"));
            }
        }
        if (File.Exists(cssPath))
        {
            sb.AppendLine();
            sb.AppendLine(File.ReadAllText(cssPath).Replace("\r\n", "\n"));
        }
        foreach (var js in JsFiles)
        {
            var path = Path.Combine(jsDir, js);
            if (File.Exists(path))
            {
                sb.AppendLine();
                sb.AppendLine(File.ReadAllText(path).Replace("\r\n", "\n"));
            }
        }
        return sb.ToString();
    }

    [Fact]
    public void PlayServer_View_Exposes_Save_Management_Modal_From_Advanced_Card()
    {
        var content = ReadPlayServerView();

        Assert.Contains("Manage saves", content);
        Assert.Contains("playServerSaveHistoryModal", content);
        Assert.Contains("playServerSaveHistoryFrame", content);
        Assert.Contains("Battery save management", content);
        Assert.Contains("Open full page", content);
        Assert.Contains("ProfileBatterySaves", content);
        Assert.Contains("batterySaveDiagnostics", content);
        Assert.Contains("var canManageBatterySaves = !hideSaveStateUi", content);
        Assert.Contains("id=\"playserver-advanced-card\"", content);
        Assert.Contains("<summary>Advanced</summary>", content);
        Assert.DoesNotContain("<div class=\"fw-semibold\">Battery saves</div>", content);
    }

    [Fact]
    public void PlayServer_View_Lazily_Loads_The_Save_Manager_Iframe_When_Opened()
    {
        var content = ReadPlayServerView();

        Assert.Contains("data-src=\"@Url.Action(\"History\", \"ProfileBatterySaves\"", content);
        Assert.Contains("show.bs.modal", content);
        Assert.Contains("hidden.bs.modal", content);
    }

    [Fact]
    public void PlayServer_View_Exposes_A_Simple_Save_State_Pill_In_The_Lower_Left()
    {
        var content = ReadPlayServerView();

        Assert.Contains("@if (!hideSaveStateUi)", content);
        Assert.Contains("id=\"nosebleed-save-state-pill\"", content);
        Assert.Contains("id=\"nosebleed-save-state-slot\"", content);
        Assert.Contains("id=\"nosebleed-save-state-save\"", content);
        Assert.Contains("id=\"nosebleed-save-state-load\"", content);
        Assert.Contains("aria-label=\"Save state slot\"", content);
        Assert.Contains(".player-state-pill {", content);
        Assert.Contains("left:max(1rem,env(safe-area-inset-left));", content);
        Assert.Contains("bottom:max(1rem,env(safe-area-inset-bottom));", content);
    }
}
