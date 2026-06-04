namespace games_vault.Tests;

public sealed class ProfileBatterySaveLoggingBridgeTests
{
    private static string ReadHistoryView()
    {
        var repoRoot = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "../../../../../"));
        var viewPath = Path.Combine(repoRoot, "Views", "ProfileBatterySaves", "History.cshtml");
        return File.ReadAllText(viewPath).Replace("\r\n", "\n");
    }

    private static string ReadPlayerScript()
    {
        var repoRoot = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "../../../../../"));
        var scriptPath = Path.Combine(repoRoot, "wwwroot", "js", "nosebleed-player", "server-player.js");
        return File.ReadAllText(scriptPath).Replace("\r\n", "\n");
    }

    [Fact]
    public void History_View_Posts_Backend_Battery_Save_Diagnostics_To_The_Player_Overlay()
    {
        var content = ReadHistoryView();

        Assert.Contains("BatterySaveDiagnostics", content);
        Assert.Contains("games-vault:player-log", content);
        Assert.Contains("postMessage", content);
    }

    [Fact]
    public void Player_Script_Listens_For_Backend_Log_Messages_From_The_Save_Manager_Iframe()
    {
        var content = ReadPlayerScript();

        Assert.Contains("addEventListener(\"message\"", content);
        Assert.Contains("games-vault:player-log", content);
        Assert.Contains("playerLogList", content);
    }
}
