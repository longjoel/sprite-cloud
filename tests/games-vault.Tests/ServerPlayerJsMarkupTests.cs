namespace games_vault.Tests;

public sealed class ServerPlayerJsMarkupTests
{
    private static string ReadServerPlayerJs()
    {
        var repoRoot = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "../../../../../"));
        var scriptPath = Path.Combine(repoRoot, "wwwroot", "js", "nosebleed-player", "server-player.js");
        return File.ReadAllText(scriptPath).Replace("\r\n", "\n");
    }

    [Fact]
    public void ServerPlayerJs_Persists_And_Applies_Windowed_And_Theater_View_Modes()
    {
        var content = ReadServerPlayerJs();

        Assert.Contains("games-vault:nosebleed-view-mode", content);
        Assert.Contains("function normalizeViewMode", content);
        Assert.Contains("function applyViewMode", content);
        Assert.Contains("view-mode-theater", content);
        Assert.Contains("Windowed view enabled.", content);
        Assert.Contains("Theater view enabled.", content);
    }

    [Fact]
    public void ServerPlayerJs_Updates_FullScreen_Button_Copy()
    {
        var content = ReadServerPlayerJs();

        Assert.Contains("Exit full screen", content);
        Assert.Contains("Full screen", content);
        Assert.Contains("syncViewModeButtons", content);
    }
}
