/// Video pipeline configuration.
///
/// Resolution: 320×240 QVGA
///   Chosen for low bandwidth and CPU overhead during development.
///   The real resolution will come from the emulator core at runtime.
///
/// Frame rate: 30 fps
///   Matches NTSC console output (29.97 ~ 30). The RTP clock is 90 kHz
///   (VP8 standard), giving a timestamp increment of 90_000 / 30 = 3_000.
///
/// Bitrate: 500 kbps VP8 (CBR)
///   Conservative default for 320×240 — high enough to avoid macroblocking
///   on fast motion, low enough for a real-time LAN stream.

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

// ---------------------------------------------------------------------------
// Audio pipeline configuration
// ---------------------------------------------------------------------------

/// Audio sample rate (Hz). Opus native rate.
pub const AUDIO_SAMPLE_RATE: u32 = 48_000;

/// Audio channels in the RTP stream. Opus supports 1 (mono) or 2 (stereo).
/// Test tone is mono; the SDP advertises stereo for compatibility.
pub const AUDIO_CHANNELS: u16 = 2;

/// RTP timestamp increment per audio frame (sample_rate / fps).
pub const AUDIO_RTP_TIMESTAMP_INCREMENT: u32 = AUDIO_SAMPLE_RATE / VIDEO_FPS; // 1600

/// Max encoded bytes per Opus frame.
/// 20 ms mono @ 48 kHz fits in ~4000 bytes with generous headroom.
pub const OPUS_MAX_FRAME_BYTES: usize = 4000;

/// Opus SDP fmtp line — forward error correction + 10 ms minimum packet time.
pub const OPUS_SDP_FMTP: &str = "minptime=10;useinbandfec=1";

/// Audio track ID sent in SDP.
pub const AUDIO_TRACK_ID: &str = "audio";

// ---------------------------------------------------------------------------
// Test tone constants
// ---------------------------------------------------------------------------

/// Test tone frequency in Hz. A4 = 440 Hz.
pub const TEST_TONE_FREQ: f64 = 440.0;

/// Test tone amplitude. 16_384 ≈ -18 dBFS for a 16-bit PCM signal —
/// loud enough to hear without risking clipping during Opus encoding.
pub const TEST_TONE_AMPLITUDE: f64 = 16_384.0;

/// CORS allowed origins.
///
/// In production, set `ALLOWED_ORIGIN` to your gv-web URL
/// (e.g. "https://games.example.com").
///
/// In dev (no env var set), allows localhost and any LAN IP that
/// gv-web might be accessed from — so the browser on a different
/// machine can reach the worker without CORS blocking.
pub fn allowed_origins() -> Vec<String> {
    use local_ip_address::local_ip;

    if let Ok(origin) = std::env::var("ALLOWED_ORIGIN") {
        return origin.split(',').map(|s| s.trim().to_string()).collect();
    }

    let mut origins = vec![
        "http://localhost:3001".to_string(),
        "http://localhost:3000".to_string(),
        "http://127.0.0.1:3001".to_string(),
        "http://127.0.0.1:3000".to_string(),
        "http://vault.local:8080".to_string(),
    ];

    // Allow gv-web origins from any LAN IP the browser might use.
    // In dev, the browser may connect from any local address.
    if let Ok(ip) = local_ip() {
        for port in &[3000u16, 3001, 8080] {
            origins.push(format!("http://{}:{}", ip, port));
        }
    }

    origins
}

/// ICE gathering timeout in seconds.
/// window, the SDP exchange is aborted.
pub const ICE_GATHERING_TIMEOUT_SECS: u64 = 10;

// ---------------------------------------------------------------------------
// DataChannel diagnostics configuration
// ---------------------------------------------------------------------------

/// Test pattern constants.
pub const PATTERN_SQUARE: u8 = 0;
pub const PATTERN_BARS: u8 = 1;

/// How long to wait for the browser's DataChannel after SDP exchange.
pub const DC_RECEIVE_TIMEOUT_SECS: u64 = 5;

/// How often to send per-frame stats over DataChannel (in frames).
/// Every 5th frame (~6 Hz) for smooth HUD updates.
pub const STATS_SEND_INTERVAL: u64 = 5;
