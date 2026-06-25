use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::time::Duration;

// ── Config ────────────────────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Config {
    pub gv_web: GvWeb,
    pub auth: Auth,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rom: Option<Rom>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct GvWeb {
    /// Base URL of the gv-web instance (e.g. "https://games.example.com")
    pub url: String,
    /// Path to the gv-worker binary (optional).
    ///
    /// When set, overrides the `GV_WORKER_BIN` env var and the auto-detection
    /// fallback (`./target/release/gv-worker` → `./target/debug/gv-worker`).
    ///
    /// Useful for production deployments where the binary lives outside the
    /// Cargo target directory (e.g. `/opt/games-vault/gv-worker`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub worker_bin: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Auth {
    /// API key issued during pairing (gvsk_...)
    pub api_key: String,
    /// Server ID assigned by gv-web during pairing
    pub server_id: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Rom {
    /// One or more root directories to scan for ROM files.
    /// gv-web discovers games by walking these paths.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub roots: Vec<String>,
}

// ── Paths ─────────────────────────────────────────────────────────────

fn config_path() -> PathBuf {
    let mut path = dirs::config_dir().unwrap_or_else(|| PathBuf::from("."));
    path.push("games-vault");
    path.push("config.toml");
    path
}

// ── Load / Save ───────────────────────────────────────────────────────

pub fn load() -> Result<Config> {
    let path = config_path();
    let content = std::fs::read_to_string(&path)
        .with_context(|| format!("config not found at {}", path.display()))?;
    toml::from_str(&content).context("invalid config")
}

pub fn save(config: &Config) -> Result<()> {
    let path = config_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).context("create config dir")?;
    }
    let content = toml::to_string_pretty(config).context("serialize config")?;
    std::fs::write(&path, content)
        .with_context(|| format!("write config to {}", path.display()))?;
    Ok(())
}

// ── Runtime-configurable constants ─────────────────────────────────────

/// Default HTTP request timeout for gv-web API calls (seconds).
const DEFAULT_HTTP_TIMEOUT_SECS: u64 = 30;

fn env_or<T: std::str::FromStr>(name: &str, default: T) -> T {
    std::env::var(name)
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(default)
}

/// HTTP request timeout for gv-web API calls.
pub fn http_timeout() -> Duration {
    use std::sync::LazyLock;
    static TIMEOUT: LazyLock<Duration> = LazyLock::new(|| {
        let secs = env_or("GV_WEB_TIMEOUT_SECS", DEFAULT_HTTP_TIMEOUT_SECS)
            .max(1);
        Duration::from_secs(secs)
    });
    *TIMEOUT
}

// ── GStreamer encoder config (from gv-worker) ────────────────────────

/// Target bitrate in kbps. GV_GST_VIDEO_BITRATE_KBPS, default 2000.
pub fn gst_video_bitrate_kbps() -> u32 {
    use std::sync::LazyLock;
    static V: LazyLock<u32> = LazyLock::new(|| env_or("GV_GST_VIDEO_BITRATE_KBPS", 2000));
    *V
}

/// VP8 cpu-used: 0 (best quality) … 16 (fastest).
pub fn gst_video_cpu_used() -> i32 {
    use std::sync::LazyLock;
    static V: LazyLock<i32> = LazyLock::new(|| env_or("GV_GST_VIDEO_CPU_USED", 4));
    *V
}

/// VP8 encoder threads. GV_GST_VIDEO_THREADS, default 4.
pub fn gst_video_threads() -> u32 {
    use std::sync::LazyLock;
    static V: LazyLock<u32> = LazyLock::new(|| env_or("GV_GST_VIDEO_THREADS", 4));
    *V
}

/// Encoder deadline: 0 (best) or 1 (realtime). GV_GST_VIDEO_DEADLINE, default 1.
pub fn gst_video_deadline() -> u32 {
    use std::sync::LazyLock;
    static V: LazyLock<u32> = LazyLock::new(|| env_or("GV_GST_VIDEO_DEADLINE", 1));
    *V
}

/// Keyframe max distance in frames. GV_GST_VIDEO_KEYFRAME_MAX_DIST, default 150.
pub fn gst_video_keyframe_max_dist() -> u32 {
    use std::sync::LazyLock;
    static V: LazyLock<u32> = LazyLock::new(|| env_or("GV_GST_VIDEO_KEYFRAME_MAX_DIST", 150));
    *V
}

/// Target height for integer scaling. GV_GST_VIDEO_SCALE_HEIGHT, default 0.
pub fn gst_video_scale_height() -> u32 {
    use std::sync::LazyLock;
    static V: LazyLock<u32> = LazyLock::new(|| env_or("GV_GST_VIDEO_SCALE_HEIGHT", 0));
    *V
}

/// Maximum integer scale factor. GV_GST_VIDEO_MAX_SCALE, default 4.
pub fn gst_video_max_scale() -> u32 {
    use std::sync::LazyLock;
    static V: LazyLock<u32> = LazyLock::new(|| env_or("GV_GST_VIDEO_MAX_SCALE", 4));
    *V
}

/// H.264 GStreamer encoder factory. GV_GST_VIDEO_H264_ENCODER, default auto.
pub fn gst_video_h264_encoder() -> String {
    use std::sync::LazyLock;
    static V: LazyLock<String> = LazyLock::new(|| {
        std::env::var("GV_GST_VIDEO_H264_ENCODER")
            .unwrap_or_else(|_| "auto".into())
            .trim()
            .to_string()
    });
    V.clone()
}

/// Opus bitrate in bps. GV_GST_AUDIO_BITRATE, default 64000.
pub fn gst_audio_bitrate() -> u32 {
    use std::sync::LazyLock;
    static V: LazyLock<u32> = LazyLock::new(|| env_or("GV_GST_AUDIO_BITRATE", 64000));
    *V
}
