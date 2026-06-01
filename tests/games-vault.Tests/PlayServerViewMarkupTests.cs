namespace games_vault.Tests;

public sealed class PlayServerViewMarkupTests
{
    private static string ReadPlayServerView()
    {
        var repoRoot = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "../../../../../"));
        var viewPath = Path.Combine(repoRoot, "Views", "Games", "PlayServer.cshtml");
        return File.ReadAllText(viewPath).Replace("\r\n", "\n");
    }

    [Fact]
    public void PlayerToolbar_Exposes_Transport_And_Compression_Pickers()
    {
        var content = ReadPlayServerView();

        Assert.Contains("id=\"nosebleed-video-transport\"", content);
        Assert.Contains("<option value=\"webrtc-track\">WebRTC track</option>", content);
        Assert.Contains("<option value=\"websocket\">WebSocket</option>", content);
        Assert.Contains("id=\"nosebleed-video-compression\"", content);
        Assert.Contains("<option value=\"balanced\">JPEG balanced</option>", content);
        Assert.Contains("<option value=\"compact\">JPEG compact</option>", content);
    }

    [Fact]
    public void PlayerSurface_Exposes_Hidden_WebRtc_Audio_Element()
    {
        var content = ReadPlayServerView();

        Assert.Contains("id=\"nosebleed-rtc-audio\"", content);
        Assert.Contains("<audio id=\"nosebleed-rtc-audio\" class=\"d-none\" autoplay playsinline muted></audio>", content);
    }
}
