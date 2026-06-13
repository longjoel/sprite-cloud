use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

// ── Config ────────────────────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Config {
    pub gv_web: GvWeb,
    pub auth: Auth,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct GvWeb {
    /// Base URL of the gv-web instance (e.g. "https://games.example.com")
    pub url: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Auth {
    /// API key issued during pairing (gvsk_...)
    pub api_key: String,
    /// Server ID assigned by gv-web during pairing
    pub server_id: String,
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
