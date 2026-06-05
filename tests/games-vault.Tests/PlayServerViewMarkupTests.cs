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
    public void PlayerSurface_Uses_AutoConnect_Without_Stream_Settings_Panel()
    {
        var content = ReadPlayServerView();

        Assert.DoesNotContain("class=\"playserver-advanced-controls mb-3\" open", content);
        Assert.DoesNotContain(">Stream settings</summary>", content);
        Assert.DoesNotContain("id=\"nosebleed-status\"", content);
        Assert.DoesNotContain("id=\"nosebleed-video-transport\"", content);
        Assert.DoesNotContain("id=\"nosebleed-video-compression\"", content);
        Assert.DoesNotContain("id=\"nosebleed-touch-toggle\"", content);
        Assert.DoesNotContain("id=\"nosebleed-gamepad-select\"", content);
        Assert.DoesNotContain("id=\"nosebleed-pad-test-toggle\"", content);
        Assert.DoesNotContain("id=\"nosebleed-pad-test-panel\"", content);
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
        Assert.Contains("<div class=\"fw-semibold\">Seats</div>", content);
        Assert.Contains(">Leave seat</button>", content);
    }

    [Fact]
    public void RoomPresencePanel_Does_Not_Render_Separate_Viewers_List()
    {
        var content = ReadPlayServerView();

        Assert.DoesNotContain("id=\"room-presence-watchers\"", content);
        Assert.DoesNotContain("presenceWatchersEl", content);
        Assert.DoesNotContain("payload.watchers", content);
        Assert.DoesNotContain("watching", content);
    }

    [Fact]
    public void SeatCards_Highlight_The_Current_Player_Seat()
    {
        var content = ReadPlayServerView();

        Assert.Contains("const currentPlayerNumber = Number.isInteger(config.playerNumber) ? config.playerNumber : null;", content);
        Assert.Contains("const isCurrentSeat = currentPlayerNumber === playerNumber;", content);
        Assert.Contains("occupantEl.className = isCurrentSeat ? 'fw-bold' : 'fw-semibold';", content);
        Assert.Contains("statusEl.textContent = isCurrentSeat ? `${statusText} · your seat` : statusText;", content);
    }

    [Fact]
    public void PlayerSurface_Exposes_Trimmed_InPlayer_Chrome_For_Primary_Actions()
    {
        var content = ReadPlayServerView();

        Assert.Contains("id=\"nosebleed-player-chrome\"", content);
        Assert.Contains("id=\"server-player-shell\" class=\"server-player-shell bg-dark rounded p-2\" tabindex=\"0\"", content);
        Assert.Contains("aria-label=\"Game player surface\"", content);
        Assert.Contains("id=\"nosebleed-player-bottom-bar\"", content);
        Assert.Contains("id=\"nosebleed-player-prompt\"", content);
        Assert.Contains("id=\"nosebleed-view-windowed\"", content);
        Assert.Contains("id=\"nosebleed-view-theater\"", content);
        Assert.Contains("id=\"nosebleed-fullscreen\"", content);
        Assert.Contains("id=\"nosebleed-logging-toggle\"", content);
        Assert.Contains("id=\"nosebleed-player-log\"", content);
        Assert.Contains("id=\"nosebleed-player-log-list\"", content);
        Assert.Contains("aria-label=\"Windowed view\"", content);
        Assert.Contains("aria-label=\"Theater view\"", content);
        Assert.Contains("aria-label=\"Toggle logging overlay\"", content);
        Assert.Contains("id=\"nosebleed-audio-overlay\"", content);
        Assert.Contains("id=\"nosebleed-volume\"", content);
        Assert.Contains("id=\"nosebleed-player-health\"", content);
        Assert.DoesNotContain("id=\"nosebleed-audio\"", content);
        Assert.DoesNotContain("id=\"nosebleed-connect\"", content);
        Assert.DoesNotContain("id=\"nosebleed-controller-scan\"", content);
    }

    [Fact]
    public void Desktop_Player_View_Hides_Layout_Edit_Buttons_And_Uses_Icon_Chrome()
    {
        var content = ReadPlayServerView();

        Assert.Contains("@@media (hover: hover) and (pointer: fine)", content);
        Assert.Contains(".layout-lock-action,", content);
        Assert.Contains(".layout-reset-action", content);
        Assert.Contains("justify-content: flex-end;", content);
        Assert.Contains("class=\"player-control-icon\"", content);
        Assert.Contains("<svg viewBox=\"0 0 24 24\"", content);
        Assert.Contains("class=\"player-volume-slider\"", content);
        Assert.Contains("title=\"Windowed view\"", content);
        Assert.Contains("title=\"Theater view\"", content);
        Assert.Contains("title=\"Full screen\"", content);
        Assert.DoesNotContain("<span class=\"player-control-label\">Full screen</span>", content);
        Assert.DoesNotContain("<span class=\"player-control-label\">Logs</span>", content);
        Assert.DoesNotContain("loggingToggleButton.textContent", File.ReadAllText(Path.Combine(Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "../../../../../")), "wwwroot", "js", "nosebleed-player", "server-player.js")));
        Assert.DoesNotContain("id=\"nosebleed-audio-overlay\" class=\"btn btn-outline-secondary d-none\"", content);
    }

    [Fact]
    public void PlayerSurface_Documents_Firefox_Gamepad_Discovery_Limitation()
    {
        var content = ReadPlayServerView();

        Assert.Contains("id=\"playserver-gamepad-browser-note\" hidden", content);
        Assert.Contains("id=\"playserver-gamepad-browser-note-dismiss\"", content);
        Assert.Contains("Dismiss controller note permanently", content);
        Assert.Contains("games-vault:playserver-gamepad-browser-note-dismissed", content);
        Assert.Contains("storage?.setItem(storageKey, '1')", content);
        Assert.Contains("storage?.getItem(storageKey) === '1'", content);
        Assert.Contains("Controller note", content);
        Assert.Contains("Browsers may wait to expose already-connected gamepads", content);
        Assert.Contains("unplug it, plug it back in", content);
    }

    [Fact]
    public void PlayerSurface_Does_Not_Render_Debug_Hud_Or_Topline_Chrome()
    {
        var content = ReadPlayServerView();

        Assert.DoesNotContain("id=\"nosebleed-player-room-meta\"", content);
        Assert.DoesNotContain("id=\"nosebleed-video-chip\"", content);
        Assert.DoesNotContain("id=\"nosebleed-input-chip\"", content);
        Assert.DoesNotContain("id=\"nosebleed-pad-chip\"", content);
        Assert.DoesNotContain("id=\"nosebleed-fps-chip\"", content);
        Assert.DoesNotContain("id=\"nosebleed-status-chip\"", content);
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

        Assert.Contains("var hideSaveStateUi = isArcadeRoom;", content);
        Assert.Contains("var sessionTitle = game.Name;", content);
        Assert.DoesNotContain("Server-side session", content);
        Assert.DoesNotContain("Server-side player is not ready", content);
    }

    [Fact]
    public void RoomChat_Form_Posts_To_Explicit_Games_RoomChat_Endpoint()
    {
        var content = ReadPlayServerView();

        Assert.Contains("action=\"@Url.Action(\"RoomChat\", \"Games\", new { roomId = Model.CurrentRoomId })\"", content);
        Assert.DoesNotContain("<form asp-action=\"RoomChat\"", content);
    }

    [Fact]
    public void PlayServer_Does_Not_Render_Manual_Play_Section_For_Normal_Games()
    {
        var content = ReadPlayServerView();

        Assert.DoesNotContain(">Play</div>", content);
        Assert.DoesNotContain(">Play</button>", content);
        Assert.DoesNotContain("Open a fresh session from this game page", content);
        Assert.DoesNotContain("Join code", content);
        Assert.DoesNotContain("Join room", content);
        Assert.DoesNotContain("Create a fresh room or join by 4-letter code.", content);
    }

    [Fact]
    public void Share_Card_Is_Renamed_Advanced_And_Houses_Battery_Save_Actions()
    {
        var content = ReadPlayServerView();

        Assert.Contains("id=\"playserver-advanced-card\"", content);
        Assert.Contains("<summary>Advanced</summary>", content);
        Assert.DoesNotContain("id=\"playserver-share-card\"", content);
        Assert.DoesNotContain("<summary>Share</summary>", content);
        Assert.Contains("<div class=\"fw-semibold small mb-2\">Share links</div>", content);
        Assert.Contains("<div class=\"fw-semibold small mb-2\">Battery saves</div>", content);
        Assert.Contains(">Flush save</button>", content);
        Assert.Contains(">Upload save</a>", content);
        Assert.Contains(">Save history</a>", content);
    }
}
