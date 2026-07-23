use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::time::Duration;

// ── Config ────────────────────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Config {
    pub sc_web: ScWeb,
    pub auth: Auth,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rom: Option<Rom>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cores: Option<Cores>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ice: Option<Ice>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ScWeb {
    /// Base URL of the sc-web instance (e.g. "https://games.example.com")
    pub url: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Auth {
    /// API key issued during pairing (scsk_...)
    pub api_key: String,
    /// Server ID assigned by sc-web during pairing
    pub server_id: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Rom {
    /// One or more root directories to scan for ROM files.
    /// sc-web discovers games by walking these paths.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub roots: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Cores {
    /// Directory containing libretro cores (.so files).
    pub dir: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Ice {
    /// STUN server URL (e.g. "stun:stun.l.google.com:19302")
    pub stun_url: String,
    /// ICE transport policy: "all" or "relay"
    #[serde(default = "default_ice_policy")]
    pub policy: String,
    /// Optional TURN server config
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn: Option<Turn>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Turn {
    pub url: String,
    pub username: String,
    pub credential: String,
}

fn default_ice_policy() -> String {
    "all".to_string()
}

// ── Paths ─────────────────────────────────────────────────────────────

fn config_path() -> PathBuf {
    let mut path = dirs::config_dir().unwrap_or_else(|| PathBuf::from("."));
    path.push("sprite-cloud");
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

/// Default HTTP request timeout for sc-web API calls (seconds).
const DEFAULT_HTTP_TIMEOUT_SECS: u64 = 30;
const DEFAULT_STUN_URL: &str = "stun:stun.l.google.com:19302";

fn env_or<T: std::str::FromStr>(name: &str, default: T) -> T {
    std::env::var(name)
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(default)
}

fn csv_env(name: &str) -> Vec<String> {
    std::env::var(name)
        .ok()
        .map(|s| {
            s.split(',')
                .map(|p| p.trim().to_string())
                .filter(|p| !p.is_empty())
                .collect()
        })
        .unwrap_or_default()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum IceTransportPolicySetting {
    All,
    Relay,
}

impl IceTransportPolicySetting {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::All => "all",
            Self::Relay => "relay",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum IceRuntimeStatus {
    DefaultFallback,
    StunOnly,
    TurnReady,
    TurnPartialInvalid,
}

impl IceRuntimeStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::DefaultFallback => "default_fallback",
            Self::StunOnly => "stun_only",
            Self::TurnReady => "turn_ready",
            Self::TurnPartialInvalid => "turn_partial_invalid",
        }
    }
}

/// Redacted summary of the effective ICE runtime configuration.
///
/// This loader centralizes the env-driven transport config so startup logs,
/// verify metadata, and WebRTC stack creation all agree on the same answer.
/// The server should never require operators to infer transport state by
/// reading `/proc/<pid>/environ` or guessing whether partial TURN config was
/// ignored. Keep secret *presence* visible here, but never surface the secret
/// values themselves.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct RuntimeIceConfig {
    pub stun_urls: Vec<String>,
    pub turn_urls: Vec<String>,
    #[serde(skip_serializing)]
    pub turn_username: Option<String>,
    #[serde(skip_serializing)]
    pub turn_credential: Option<String>,
    pub turn_username_present: bool,
    pub turn_credential_present: bool,
    pub transport_policy: IceTransportPolicySetting,
    pub status: IceRuntimeStatus,
    pub defaulted_to_public_stun: bool,
}

impl RuntimeIceConfig {
    pub fn load() -> Self {
        let stun_urls = csv_env("GV_ICE_STUN_URLS");
        let turn_urls = csv_env("GV_ICE_TURN_URLS");
        let turn_username = std::env::var("GV_ICE_TURN_USERNAME")
            .ok()
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty());
        let turn_credential = std::env::var("GV_ICE_TURN_CREDENTIAL")
            .ok()
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty());
        let turn_username_present = turn_username.is_some();
        let turn_credential_present = turn_credential.is_some();
        let transport_policy = match std::env::var("GV_ICE_TRANSPORT_POLICY").ok().as_deref() {
            Some("relay") => IceTransportPolicySetting::Relay,
            _ => IceTransportPolicySetting::All,
        };

        let has_turn_urls = !turn_urls.is_empty();
        let has_stun_urls = !stun_urls.is_empty();
        let turn_ready = has_turn_urls && turn_username_present && turn_credential_present;
        let turn_partial = has_turn_urls && !turn_ready;
        let defaulted_to_public_stun = !has_stun_urls && !has_turn_urls;
        let status = if turn_ready {
            IceRuntimeStatus::TurnReady
        } else if turn_partial {
            IceRuntimeStatus::TurnPartialInvalid
        } else if has_stun_urls {
            IceRuntimeStatus::StunOnly
        } else {
            IceRuntimeStatus::DefaultFallback
        };

        Self {
            stun_urls,
            turn_urls,
            turn_username,
            turn_credential,
            turn_username_present,
            turn_credential_present,
            transport_policy,
            status,
            defaulted_to_public_stun,
        }
    }

    pub fn effective_stun_urls(&self) -> Vec<String> {
        if self.stun_urls.is_empty() && self.turn_urls.is_empty() {
            vec![DEFAULT_STUN_URL.to_string()]
        } else {
            self.stun_urls.clone()
        }
    }

    pub fn turn_ready(&self) -> bool {
        self.status == IceRuntimeStatus::TurnReady
    }

    pub fn startup_log_fields(&self) -> IceRuntimeLogFields {
        IceRuntimeLogFields {
            status: self.status.as_str().to_string(),
            transport_policy: self.transport_policy.as_str().to_string(),
            stun_url_count: self.effective_stun_urls().len(),
            turn_url_count: self.turn_urls.len(),
            turn_username_present: self.turn_username_present,
            turn_credential_present: self.turn_credential_present,
            defaulted_to_public_stun: self.defaulted_to_public_stun,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct IceRuntimeLogFields {
    pub status: String,
    pub transport_policy: String,
    pub stun_url_count: usize,
    pub turn_url_count: usize,
    pub turn_username_present: bool,
    pub turn_credential_present: bool,
    pub defaulted_to_public_stun: bool,
}

pub fn runtime_ice_config() -> RuntimeIceConfig {
    use std::sync::LazyLock;
    static ICE: LazyLock<RuntimeIceConfig> = LazyLock::new(RuntimeIceConfig::load);
    ICE.clone()
}

/// HTTP request timeout for sc-web API calls.
pub fn http_timeout() -> Duration {
    use std::sync::LazyLock;
    static TIMEOUT: LazyLock<Duration> = LazyLock::new(|| {
        let secs = env_or("GV_WEB_TIMEOUT_SECS", DEFAULT_HTTP_TIMEOUT_SECS).max(1);
        Duration::from_secs(secs)
    });
    *TIMEOUT
}

/// LAN player HTTP port exposed by sc-server. GV_PLAYER_PORT, default 8787.
pub fn player_port() -> u16 {
    use std::sync::LazyLock;
    static PORT: LazyLock<u16> = LazyLock::new(|| env_or("GV_PLAYER_PORT", 8787));
    *PORT
}

// ── GStreamer encoder config ─────────────────────────────────────────

/// Target bitrate in kbps. GV_GST_VIDEO_BITRATE_KBPS, default 800.
pub fn gst_video_bitrate_kbps() -> u32 {
    use std::sync::LazyLock;
    static V: LazyLock<u32> = LazyLock::new(|| env_or("GV_GST_VIDEO_BITRATE_KBPS", 800));
    *V
}

/// Keyframe max distance in frames. GV_GST_VIDEO_KEYFRAME_MAX_DIST, default 30 (0.5s @ 60fps).
pub fn gst_video_keyframe_max_dist() -> u32 {
    use std::sync::LazyLock;
    static V: LazyLock<u32> = LazyLock::new(|| env_or("GV_GST_VIDEO_KEYFRAME_MAX_DIST", 30));
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
