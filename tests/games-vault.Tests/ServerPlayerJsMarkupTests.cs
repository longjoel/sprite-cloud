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

    [Fact]
    public void ServerPlayerJs_Implements_Transient_Player_Chrome_Visibility()
    {
        var content = ReadServerPlayerJs();

        Assert.Contains("function wakePlayerChrome", content);
        Assert.Contains("function setPlayerChromeVisible", content);
        Assert.Contains("player-chrome-hidden", content);
        Assert.Contains("window.addEventListener(\"pointermove\"", content);
        Assert.Contains("window.addEventListener(\"focus\"", content);
    }

    [Fact]
    public void ServerPlayerJs_Maps_Status_Changes_Into_Player_Events_And_Prompts()
    {
        var content = ReadServerPlayerJs();

        Assert.Contains("function showTransientPlayerEvent", content);
        Assert.Contains("function showTransientPlayerPrompt", content);
        Assert.Contains("Controller socket disconnected", content);
        Assert.Contains("Controller live again", content);
        Assert.Contains("Audio enabled", content);
    }

    [Fact]
    public void ServerPlayerJs_Swaps_Gamepad_A_And_B_Button_Indices_For_Browser_Input()
    {
        var content = ReadServerPlayerJs();

        Assert.Contains("a: keys.has(\"KeyZ\") || touchControls.has(\"a\") || !!pad?.buttons[1]?.pressed", content);
        Assert.Contains("b: keys.has(\"KeyX\") || touchControls.has(\"b\") || !!pad?.buttons[0]?.pressed", content);
    }

    [Fact]
    public void ServerPlayerJs_Defaults_Overlay_On_And_Manages_Overlay_Audio_Volume()
    {
        var content = ReadServerPlayerJs();

        Assert.Contains("const volumeStorageKey = \"games-vault:nosebleed-volume\"", content);
        Assert.Contains("function applyAudioVolume", content);
        Assert.Contains("function syncOverlayAudioUi", content);
        Assert.Contains("audioGainNode", content);
        Assert.Contains("volumeSlider?.addEventListener(\"input\"", content);
        Assert.Contains("setOverlayEnabled(true, false);", content);
    }
}
