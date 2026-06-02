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

    [Fact]
    public void RoomPresencePanel_Exposes_Seat_And_Roster_Containers()
    {
        var content = ReadPlayServerView();

        Assert.Contains("id=\"playserver-session-grid\"", content);
        Assert.Contains("id=\"room-seat-strip\"", content);
        Assert.Contains("id=\"playserver-roster-card\"", content);
        Assert.Contains("id=\"room-presence-watchers\"", content);
        Assert.Contains("<div class=\"fw-semibold\">Seats</div>", content);
    }

    [Fact]
    public void PlayerSurface_Hides_Advanced_Controls_Behind_Details_Beneath_Chat()
    {
        var content = ReadPlayServerView();

        Assert.Contains("class=\"playserver-advanced-controls mb-3\" open", content);
        Assert.Contains(">Player controls</summary>", content);
        Assert.Contains("id=\"room-chat-panel\"", content);
        Assert.Contains("id=\"nosebleed-status\"", content);

        var chatIndex = content.IndexOf("id=\"room-chat-panel\"", StringComparison.Ordinal);
        var controlsIndex = content.IndexOf("class=\"playserver-advanced-controls mb-3\" open", StringComparison.Ordinal);
        Assert.True(chatIndex >= 0 && controlsIndex > chatIndex, "Player controls should appear beneath the chat panel.");
    }

    [Fact]
    public void PlayerControls_Expose_ViewMode_Audio_And_FullScreen_Actions()
    {
        var content = ReadPlayServerView();

        Assert.Contains("id=\"nosebleed-view-windowed\"", content);
        Assert.Contains("id=\"nosebleed-view-theater\"", content);
        Assert.Contains("id=\"nosebleed-fullscreen\"", content);
        Assert.Contains(">Full screen</button>", content);
        Assert.Contains("id=\"nosebleed-audio\"", content);
        Assert.Contains("<div class=\"playserver-control-group-title\">View</div>", content);
        Assert.Contains("<div class=\"playserver-control-group-title\">Playback</div>", content);
    }

    [Fact]
    public void Hero_Does_Not_Render_Watching_Badge_Artifact()
    {
        var content = ReadPlayServerView();

        Assert.DoesNotContain("text-bg-success-subtle", content);
        Assert.DoesNotContain(">Watching<", content);
    }

    [Fact]
    public void Hero_Uses_Game_Title_Without_Room_Code_Or_ServerSide_Label()
    {
        var content = ReadPlayServerView();

        Assert.Contains("var sessionTitle = game.Name;", content);
        Assert.DoesNotContain("Room ", content);
        Assert.DoesNotContain("Server-side session", content);
        Assert.DoesNotContain("Server-side player is not ready", content);
    }

    [Fact]
    public void RoomControls_Only_Expose_Create_New_Session()
    {
        var content = ReadPlayServerView();

        Assert.Contains(">Play</div>", content);
        Assert.Contains(">Play</button>", content);
        Assert.DoesNotContain("Join code", content);
        Assert.DoesNotContain("Join room", content);
        Assert.DoesNotContain("Create a fresh room or join by 4-letter code.", content);
    }
}
