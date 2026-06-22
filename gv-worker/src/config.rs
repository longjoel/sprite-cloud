//! Worker configuration — all tunables via env vars with sensible defaults.
//!
//! GStreamer encoder params follow nosebleed's naming convention
//! (GV_GST_VIDEO_*, GV_GST_AUDIO_*) for discoverability.

use std::sync::LazyLock;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VideoCodecPreference {
    Auto,
    Vp8,
    H264,
}

// ── Helper ──────────────────────────────────────────────────────────────────

fn env_or<T: std::str::FromStr>(name: &str, default: T) -> T {
    std::env::var(name)
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(default)
}

// ── ICE / STUN / TURN ───────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq)]
pub struct IceServer {
    pub urls: Vec<String>,
    pub username: Option<String>,
    pub credential: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum IceTransportPolicy {
    All,
    Relay,
}

#[derive(Debug, Clone, PartialEq)]
pub struct IceConfig {
    pub servers: Vec<IceServer>,
    pub transport_policy: IceTransportPolicy,
}

pub fn ice_config() -> IceConfig {
    let stun_urls: Vec<String> = std::env::var("GV_ICE_STUN_URLS")
        .ok()
        .map(|s| s.split(',').map(|p| p.trim().to_string()).filter(|p| !p.is_empty()).collect())
        .unwrap_or_default();

    let turn_urls: Vec<String> = std::env::var("GV_ICE_TURN_URLS")
        .ok()
        .map(|s| s.split(',').map(|p| p.trim().to_string()).filter(|p| !p.is_empty()).collect())
        .unwrap_or_default();

    let turn_username = std::env::var("GV_ICE_TURN_USERNAME").ok();
    let turn_credential = std::env::var("GV_ICE_TURN_CREDENTIAL").ok();
    let policy = match std::env::var("GV_ICE_TRANSPORT_POLICY").ok().as_deref() {
        Some("relay") => IceTransportPolicy::Relay,
        _ => IceTransportPolicy::All,
    };

    let mut servers = Vec::new();
    if !stun_urls.is_empty() {
        servers.push(IceServer { urls: stun_urls, username: None, credential: None });
    }
    if !turn_urls.is_empty() {
        servers.push(IceServer {
            urls: turn_urls,
            username: turn_username.filter(|s| !s.is_empty()),
            credential: turn_credential.filter(|s| !s.is_empty()),
        });
    }
    if servers.is_empty() {
        servers.push(IceServer {
            urls: vec!["stun:stun.l.google.com:19302".into()],
            username: None,
            credential: None,
        });
    }

    IceConfig { servers, transport_policy: policy }
}

// ── GStreamer video encoder ─────────────────────────────────────────────────

/// Video codec preference. GV_GST_VIDEO_CODEC, default auto.
/// Values: auto, vp8, h264.
pub fn gst_video_codec() -> VideoCodecPreference {
    static V: LazyLock<VideoCodecPreference> = LazyLock::new(|| {
        match std::env::var("GV_GST_VIDEO_CODEC")
            .unwrap_or_else(|_| "auto".into())
            .trim()
            .to_ascii_lowercase()
            .as_str()
        {
            "vp8" => VideoCodecPreference::Vp8,
            "h264" | "h.264" | "avc" => VideoCodecPreference::H264,
            _ => VideoCodecPreference::Auto,
        }
    });
    *V
}

/// H.264 GStreamer encoder factory. GV_GST_VIDEO_H264_ENCODER, default auto.
/// Examples: x264enc, vaapih264enc, nvh264enc.
pub fn gst_video_h264_encoder() -> String {
    static V: LazyLock<String> = LazyLock::new(|| {
        std::env::var("GV_GST_VIDEO_H264_ENCODER")
            .unwrap_or_else(|_| "auto".into())
            .trim()
            .to_string()
    });
    V.clone()
}

/// VP8 cpu-used: 0 (best quality) … 16 (fastest).
/// GV_GST_VIDEO_CPU_USED, default 4.
pub fn gst_video_cpu_used() -> i32 {
    static V: LazyLock<i32> = LazyLock::new(|| env_or("GV_GST_VIDEO_CPU_USED", 4));
    *V
}

/// VP8 encoder threads. GV_GST_VIDEO_THREADS, default 4.
pub fn gst_video_threads() -> u32 {
    static V: LazyLock<u32> = LazyLock::new(|| env_or("GV_GST_VIDEO_THREADS", 4));
    *V
}

/// Target bitrate in kbps. GV_GST_VIDEO_BITRATE_KBPS, default 2000.
pub fn gst_video_bitrate_kbps() -> u32 {
    static V: LazyLock<u32> = LazyLock::new(|| env_or("GV_GST_VIDEO_BITRATE_KBPS", 2000));
    *V
}

/// Encoder deadline: 0 (best) or 1 (realtime). GV_GST_VIDEO_DEADLINE, default 1.
pub fn gst_video_deadline() -> u32 {
    static V: LazyLock<u32> = LazyLock::new(|| env_or("GV_GST_VIDEO_DEADLINE", 1));
    *V
}

/// Keyframe max distance in frames. GV_GST_VIDEO_KEYFRAME_MAX_DIST, default 150.
pub fn gst_video_keyframe_max_dist() -> u32 {
    static V: LazyLock<u32> = LazyLock::new(|| env_or("GV_GST_VIDEO_KEYFRAME_MAX_DIST", 150));
    *V
}

/// Target height for integer scaling (nearest-neighbor).
/// GV_GST_VIDEO_SCALE_HEIGHT, default 0 (no scaling).
/// Core output is integer-scaled up to at least this height before encoding.
/// e.g. 1080 → NES 240p → 4× → 960p. Factor = max(1, floor(height / core_height)).
pub fn gst_video_scale_height() -> u32 {
    static V: LazyLock<u32> = LazyLock::new(|| env_or("GV_GST_VIDEO_SCALE_HEIGHT", 0));
    *V
}

/// Maximum integer scale factor. GV_GST_VIDEO_MAX_SCALE, default 4.
/// Prevents excessive upscaling (e.g. GB 160×144 → 7×) that overwhelms
/// the VP8 encoder at low bitrates, producing garbled output.
pub fn gst_video_max_scale() -> u32 {
    static V: LazyLock<u32> = LazyLock::new(|| env_or("GV_GST_VIDEO_MAX_SCALE", 4));
    *V
}

// ── GStreamer audio encoder ─────────────────────────────────────────────────

/// Opus bitrate in bps. GV_GST_AUDIO_BITRATE, default 64000.
pub fn gst_audio_bitrate() -> u32 {
    static V: LazyLock<u32> = LazyLock::new(|| env_or("GV_GST_AUDIO_BITRATE", 64000));
    *V
}

// ── Worker control ──────────────────────────────────────────────────────────

/// Worker HTTP control token. GV_WORKER_CONTROL_TOKEN.
pub fn worker_control_token() -> Option<String> {
    static V: LazyLock<Option<String>> = LazyLock::new(|| {
        let t = std::env::var("GV_WORKER_CONTROL_TOKEN").ok()?;
        if t.is_empty() { None } else { Some(t) }
    });
    V.clone()
}

/// Host token seeded from env (or first SDP offer). GV_HOST_TOKEN.
pub fn host_token_from_env() -> Option<String> {
    static V: LazyLock<Option<String>> = LazyLock::new(|| {
        std::env::var("GV_HOST_TOKEN").ok().filter(|s| !s.is_empty())
    });
    V.clone()
}

/// Per-peer tokens for multi-peer WebRTC auth. GV_PEER_TOKENS (JSON).
#[derive(Debug, Clone, serde::Deserialize)]
pub struct PeerToken {
    pub token: String,
    pub seat: u32,
    pub role: String, // "host" | "player" | "viewer"
}

pub fn peer_tokens() -> Vec<PeerToken> {
    static V: LazyLock<Vec<PeerToken>> = LazyLock::new(|| {
        std::env::var("GV_PEER_TOKENS")
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default()
    });
    V.clone()
}

// ── Common constants ────────────────────────────────────────────────────────

pub const AUDIO_SAMPLE_RATE: u32 = 48_000;
pub const AUDIO_CHANNELS: u16 = 2;
pub const OPUS_SDP_FMTP: &str = "minptime=10;useinbandfec=1";
pub const AUDIO_TRACK_ID: &str = "audio";
pub const VIDEO_TRACK_ID: &str = "video";
pub const STREAM_ID: &str = "gv-worker";
pub const VP8_CLOCK_RATE: u32 = 90_000;

pub const STATS_SEND_INTERVAL: u64 = 5;
pub const WORKER_IDLE_TIMEOUT_SECS: u64 = 30;
pub const WORKER_STARTUP_TIMEOUT_SECS: u64 = 60;
pub const ICE_GATHERING_TIMEOUT_SECS: u64 = 10;
pub const DC_RECEIVE_TIMEOUT_SECS: u64 = 5;

/// Auth timeout for DataChannel (seconds). GV_DC_AUTH_TIMEOUT_SECS, default 5.
pub fn dc_auth_timeout_secs() -> u64 {
    static V: LazyLock<u64> = LazyLock::new(|| env_or("GV_DC_AUTH_TIMEOUT_SECS", 5));
    *V
}

/// CORS allowed origins. GV_ALLOWED_ORIGIN or auto-detect LAN IPs.
pub fn allowed_origins() -> Vec<String> {
    static V: LazyLock<Vec<String>> = LazyLock::new(|| {
        if let Ok(o) = std::env::var("GV_ALLOWED_ORIGIN") {
            return o.split(',').map(|s| s.trim().to_string()).collect();
        }
        let mut origins = vec![
            "http://localhost:3000".into(),
            "http://localhost:3001".into(),
        ];
        if let Ok(ip) = local_ip_address::local_ip() {
            for port in [3000u16, 3001, 8080] {
                origins.push(format!("http://{ip}:{port}"));
            }
        }
        origins
    });
    V.clone()
}
