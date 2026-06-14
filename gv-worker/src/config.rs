// Video pipeline configuration.
//
// Resolution: 320×240 QVGA
//   Chosen for low bandwidth and CPU overhead during development.
//   The real resolution will come from the emulator core at runtime.
//
// Frame rate: 30 fps
//   Matches NTSC console output (29.97 ~ 30). The RTP clock is 90 kHz
//   (VP8 standard), giving a timestamp increment of 90_000 / 30 = 3_000.
//
// Bitrate: 500 kbps VP8 (CBR)
//   Conservative default for 320×240 — high enough to avoid macroblocking
//   on fast motion, low enough for a real-time LAN stream.

/// Video frame width in pixels.
pub const VIDEO_WIDTH: u32 = 320;

/// Video frame height in pixels.
pub const VIDEO_HEIGHT: u32 = 240;

/// Target frames per second.
pub const VIDEO_FPS: u32 = 30;

/// Duration of one frame in milliseconds.
pub const FRAME_INTERVAL_MS: u64 = 1000 / VIDEO_FPS as u64; // 33

/// VP8 RTP clock rate (Hz). Standard for VP8 payload.
pub const VP8_CLOCK_RATE: u32 = 90_000;

/// RTP timestamp increment per frame (clock_rate / fps).
pub const RTP_TIMESTAMP_INCREMENT: u32 = VP8_CLOCK_RATE / VIDEO_FPS; // 3000

/// Target encoder bitrate in kbps (fallback default).
const DEFAULT_BITRATE_KBPS: u32 = 500;

/// Target encoder bitrate in kbps.
/// Read from `TARGET_BITRATE_KBPS` env var at runtime, defaulting to 500.
/// Production deployments should tune this based on available bandwidth.
pub fn target_bitrate_kbps() -> u32 {
    use std::sync::LazyLock;
    static BITRATE: LazyLock<u32> = LazyLock::new(|| {
        std::env::var("TARGET_BITRATE_KBPS")
            .ok()
            .and_then(|v| v.parse().ok())
            .filter(|&v| v > 0)
            .unwrap_or(DEFAULT_BITRATE_KBPS)
    });
    *BITRATE
}

/// STUN/TURN server for NAT traversal (fallback default).
const DEFAULT_STUN_SERVER: &str = "stun:stun.l.google.com:19302";

/// STUN/TURN server for NAT traversal.
/// Read from `STUN_SERVER` env var at runtime, defaulting to Google's public STUN.
/// Production MUST set this to a dedicated TURN server.
/// Format: "stun:host:port" or "turn:host:port?transport=tcp"
pub fn stun_server() -> &'static str {
    use std::sync::LazyLock;
    static STUN: LazyLock<String> = LazyLock::new(|| {
        std::env::var("STUN_SERVER").unwrap_or_else(|_| DEFAULT_STUN_SERVER.to_string())
    });
    STUN.as_str()
}

/// WebRTC track ID sent in SDP.
pub const TRACK_ID: &str = "video";

/// WebRTC stream ID (msid) sent in SDP.
pub const STREAM_ID: &str = "gv-worker";

/// How often to emit a diagnostic log line (in frames).
/// Logs frame 1-3 always, then every N frames thereafter.
pub const DIAG_LOG_INTERVAL: u64 = 90; // ~every 3 seconds at 30 fps

/// CORS allowed origin.
///
/// In production, set `ALLOWED_ORIGIN` to your gv-web URL (e.g. "https://games.example.com").
/// Defaults to "http://localhost:3001" for local development.
pub fn allowed_origin() -> String {
    std::env::var("ALLOWED_ORIGIN")
        .unwrap_or_else(|_| "http://localhost:3001".to_string())
}

/// ICE gathering timeout in seconds.
/// window, the SDP exchange is aborted.
pub const ICE_GATHERING_TIMEOUT_SECS: u64 = 10;
