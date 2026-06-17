
/// Structured ICE server configuration.
#[derive(Debug, Clone, PartialEq)]
pub struct IceServer {
    pub urls: Vec<String>,
    pub username: Option<String>,
    pub credential: Option<String>,
}

/// ICE transport policy.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum IceTransportPolicy {
    All,
    Relay,
}

impl IceTransportPolicy {
    #[allow(dead_code)]
    pub fn as_js(&self) -> &'static str {
        match self {
            IceTransportPolicy::All => "all",
            IceTransportPolicy::Relay => "relay",
        }
    }
}

/// Parsed ICE configuration for the WebRTC peer connection.
#[derive(Debug, Clone, PartialEq)]
pub struct IceConfig {
    pub servers: Vec<IceServer>,
    pub transport_policy: IceTransportPolicy,
}

/// Default STUN server used when nothing is configured.
const DEFAULT_STUN_URL: &str = "stun:stun.l.google.com:19302";

/// Parse ICE configuration from environment variables.
///
/// Reads:
/// - GV_ICE_STUN_URLS — comma-separated STUN URLs
/// - GV_ICE_TURN_URLS — comma-separated TURN URLs
/// - GV_ICE_TURN_USERNAME — TURN username
/// - GV_ICE_TURN_CREDENTIAL — TURN credential
/// - GV_ICE_TRANSPORT_POLICY — "all" or "relay"
///
/// When no STUN or TURN URLs are configured, returns the Google STUN default.
pub fn ice_config() -> IceConfig {
    let stun_urls = parse_url_list("GV_ICE_STUN_URLS");
    let turn_urls = parse_url_list("GV_ICE_TURN_URLS");
    let turn_username = std::env::var("GV_ICE_TURN_USERNAME").ok();
    let turn_credential = std::env::var("GV_ICE_TURN_CREDENTIAL").ok();
    let policy = parse_transport_policy();

    let mut servers: Vec<IceServer> = Vec::new();

    if !stun_urls.is_empty() {
        servers.push(IceServer {
            urls: stun_urls,
            username: None,
            credential: None,
        });
    }

    if !turn_urls.is_empty() {
        let user = turn_username.filter(|s| !s.is_empty());
        let cred = turn_credential.filter(|s| !s.is_empty());
        if user.is_some() != cred.is_some() {
            tracing::warn!(
                "[ICE] GV_ICE_TURN_USERNAME and GV_ICE_TURN_CREDENTIAL must both be set or both empty"
            );
        }
        servers.push(IceServer {
            urls: turn_urls,
            username: user,
            credential: cred,
        });
    }

    if servers.is_empty() {
        servers.push(IceServer {
            urls: vec![DEFAULT_STUN_URL.to_string()],
            username: None,
            credential: None,
        });
    }

    IceConfig {
        servers,
        transport_policy: policy,
    }
}

fn parse_url_list(var: &str) -> Vec<String> {
    std::env::var(var)
        .ok()
        .map(|s| s.split(',').map(|p| p.trim().to_string()).filter(|p| !p.is_empty()).collect())
        .unwrap_or_default()
}

fn parse_transport_policy() -> IceTransportPolicy {
    match std::env::var("GV_ICE_TRANSPORT_POLICY")
        .ok()
        .as_deref()
        .unwrap_or("all")
    {
        "relay" => IceTransportPolicy::Relay,
        "all" | "" => IceTransportPolicy::All,
        other => {
            tracing::warn!(
                "[ICE] invalid GV_ICE_TRANSPORT_POLICY={}, defaulting to all",
                other
            );
            IceTransportPolicy::All
        }
    }
}

#[cfg(test)]
#[allow(non_snake_case)]
mod ice_tests {
    use super::*;
    use std::sync::Mutex;

    static ICE_ENV_MUTEX: Mutex<()> = Mutex::new(());

    fn clear_ice_env() {
        std::env::remove_var("GV_ICE_STUN_URLS");
        std::env::remove_var("GV_ICE_TURN_URLS");
        std::env::remove_var("GV_ICE_TURN_USERNAME");
        std::env::remove_var("GV_ICE_TURN_CREDENTIAL");
        std::env::remove_var("GV_ICE_TRANSPORT_POLICY");
    }

    #[test]
    fn no_env_returns_google_stun_default() {
        let _guard = ICE_ENV_MUTEX.lock().unwrap();
        clear_ice_env();
        let cfg = ice_config();
        assert_eq!(cfg.servers.len(), 1);
        assert_eq!(cfg.servers[0].urls, vec![DEFAULT_STUN_URL]);
        assert!(cfg.servers[0].username.is_none());
        assert_eq!(cfg.transport_policy, IceTransportPolicy::All);
    }

    #[test]
    fn comma_separated_stun_urls() {
        let _guard = ICE_ENV_MUTEX.lock().unwrap();
        clear_ice_env();
        std::env::set_var("GV_ICE_STUN_URLS", "stun:stun1.example.com:3478, stun:stun2.example.com:3478");
        let cfg = ice_config();
        assert_eq!(cfg.servers.len(), 1);
        assert_eq!(
            cfg.servers[0].urls,
            vec!["stun:stun1.example.com:3478", "stun:stun2.example.com:3478"]
        );
    }

    #[test]
    fn turn_url_with_credentials() {
        let _guard = ICE_ENV_MUTEX.lock().unwrap();
        clear_ice_env();
        std::env::set_var("GV_ICE_TURN_URLS", "turn:turn.example.com:3478");
        std::env::set_var("GV_ICE_TURN_USERNAME", "user");
        std::env::set_var("GV_ICE_TURN_CREDENTIAL", "pass");
        let cfg = ice_config();
        assert_eq!(cfg.servers.len(), 1); // TURN-only, falls to default? No — TURN is set
        let turn = &cfg.servers[0];
        assert_eq!(turn.urls, vec!["turn:turn.example.com:3478"]);
        assert_eq!(turn.username.as_deref(), Some("user"));
        assert_eq!(turn.credential.as_deref(), Some("pass"));
    }

    #[test]
    fn stun_and_turn_together() {
        let _guard = ICE_ENV_MUTEX.lock().unwrap();
        clear_ice_env();
        std::env::set_var("GV_ICE_STUN_URLS", "stun:stun.example.com:3478");
        std::env::set_var("GV_ICE_TURN_URLS", "turn:turn.example.com:3478");
        std::env::set_var("GV_ICE_TURN_USERNAME", "user");
        std::env::set_var("GV_ICE_TURN_CREDENTIAL", "pass");
        let cfg = ice_config();
        assert_eq!(cfg.servers.len(), 2);
        assert_eq!(cfg.servers[0].urls, vec!["stun:stun.example.com:3478"]);
        assert!(cfg.servers[0].username.is_none());
        assert_eq!(cfg.servers[1].urls, vec!["turn:turn.example.com:3478"]);
        assert_eq!(cfg.servers[1].username.as_deref(), Some("user"));
        assert_eq!(cfg.servers[1].credential.as_deref(), Some("pass"));
    }

    #[test]
    fn relay_only_policy() {
        let _guard = ICE_ENV_MUTEX.lock().unwrap();
        clear_ice_env();
        std::env::set_var("GV_ICE_TRANSPORT_POLICY", "relay");
        let cfg = ice_config();
        assert_eq!(cfg.transport_policy, IceTransportPolicy::Relay);
        // Still falls back to default STUN if no URLs configured
        assert_eq!(cfg.servers[0].urls, vec![DEFAULT_STUN_URL]);
    }

    #[test]
    fn invalid_policy_defaults_to_all() {
        let _guard = ICE_ENV_MUTEX.lock().unwrap();
        clear_ice_env();
        std::env::set_var("GV_ICE_TRANSPORT_POLICY", "garbage");
        let cfg = ice_config();
        assert_eq!(cfg.transport_policy, IceTransportPolicy::All);
    }
}

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
///
/// Video frame width in pixels (test-pattern fallback).
pub const VIDEO_WIDTH: u32 = 320;

/// Video frame height in pixels (test-pattern fallback).
pub const VIDEO_HEIGHT: u32 = 240;

/// Minimum output height for core frames before VP8 encoding.
/// Core output smaller than this is nearest-neighbor upscaled to reduce
/// macroblocking artifacts from encoding very low-resolution frames.
/// Set via GV_MIN_OUTPUT_HEIGHT env var, defaults to 480.
pub fn min_output_height() -> u32 {
    use std::sync::LazyLock;
    static MIN_H: LazyLock<u32> = LazyLock::new(|| {
        std::env::var("GV_MIN_OUTPUT_HEIGHT")
            .ok()
            .and_then(|v| v.parse().ok())
            .filter(|&v| v > 0)
            .unwrap_or(480)
    });
    *MIN_H
}

/// Target frames per second. Must match the core's native rate.
pub const VIDEO_FPS: u32 = 60;

/// Duration of one frame.
/// Float math avoids integer-truncation (1000/60 = 16 ms → 62.5 fps
/// instead of the intended 60 fps).  Returns exactly 16.667 ms @ 60 fps.
#[allow(dead_code)]
pub fn frame_interval() -> std::time::Duration {
    std::time::Duration::from_secs_f64(1.0 / VIDEO_FPS as f64)
}

/// VP8 RTP clock rate (Hz). Standard for VP8 payload.
pub const VP8_CLOCK_RATE: u32 = 90_000;

/// RTP timestamp increment per frame (clock_rate / fps) — for reference only.
/// Actual RTP timestamps use wall-clock time to avoid drift.
#[allow(dead_code)]
pub const RTP_TIMESTAMP_INCREMENT: u32 = VP8_CLOCK_RATE / VIDEO_FPS; // 1500

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

// STUN_SERVER env var is deprecated; use GV_ICE_STUN_URLS instead.
// Kept for backward compatibility with existing configs.
pub fn stun_server() -> String {
    let ice = ice_config();
    ice.servers.first().map(|s| s.urls[0].clone()).unwrap_or_else(|| "stun:stun.l.google.com:19302".to_string())
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
pub const AUDIO_CHANNELS: u16 = 2;

/// Max encoded bytes per Opus frame.
/// 20 ms stereo @ 48 kHz fits in ~4000 bytes with generous headroom.
pub const OPUS_MAX_FRAME_BYTES: usize = 4000;

/// Opus SDP fmtp line — forward error correction + 10 ms minimum packet time.
pub const OPUS_SDP_FMTP: &str = "minptime=10;useinbandfec=1";

/// Audio track ID sent in SDP.
pub const AUDIO_TRACK_ID: &str = "audio";

/// CORS allowed origins.
///
/// In production, set `ALLOWED_ORIGIN` to your gv-web URL
/// (e.g. "https://games.example.com").
///
/// In dev (no env var set), allows localhost and any LAN IP that
/// gv-web might be accessed from — so the browser on a different
/// machine can reach the worker without CORS blocking.
#[allow(dead_code)]
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
pub const PATTERN_ERROR: u8 = 2;

/// How long to wait for the browser's DataChannel after SDP exchange.
pub const DC_RECEIVE_TIMEOUT_SECS: u64 = 5;

/// How long the DataChannel has to send an auth message after opening.
/// Read from `DC_AUTH_TIMEOUT_SECS` env var at runtime, defaulting to 5.
pub fn dc_auth_timeout_secs() -> u64 {
    use std::sync::LazyLock;
    static TIMEOUT: LazyLock<u64> = LazyLock::new(|| {
        std::env::var("DC_AUTH_TIMEOUT_SECS")
            .ok()
            .and_then(|v| v.parse().ok())
            .filter(|&v| v > 0)
            .unwrap_or(5)
    });
    *TIMEOUT
}

/// How often to send per-frame stats over DataChannel (in frames).
/// Every 5th frame (~6 Hz) for smooth HUD updates.
pub const STATS_SEND_INTERVAL: u64 = 5;

/// Max seconds a worker stays alive without a peer connection.
/// If no SDP offer arrives within this time after startup, or the
/// last peer disconnects and no new offer arrives, the worker exits.
pub const WORKER_IDLE_TIMEOUT_SECS: u64 = 30;

/// Max seconds to wait for the very first SDP offer after startup.
/// Longer than idle timeout so the browser has time to load + connect.
pub const WORKER_STARTUP_TIMEOUT_SECS: u64 = 60;
