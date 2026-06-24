//! Release manifest and component-version collection.
//!
//! Reads the release manifest embedded at build time and collects
//! version metadata for reporting to gv-web.

use serde::Deserialize;
use std::path::PathBuf;

use crate::config;
use crate::gv_web;
use crate::worker;

// ── Release metadata collection ───────────────────────────────────────

#[derive(Debug, Deserialize)]
struct ReleaseArtifactManifest {
    sha256: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ReleaseArtifacts {
    gv_server: Option<ReleaseArtifactManifest>,
    gv_worker: Option<ReleaseArtifactManifest>,
}

#[derive(Debug, Deserialize)]
struct ReleaseManifest {
    git_sha: Option<String>,
    built_at_utc: Option<String>,
    released_at_utc: Option<String>,
    artifacts: Option<ReleaseArtifacts>,
}

fn release_manifest_path() -> PathBuf {
    std::env::var("GV_RELEASE_MANIFEST_PATH")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("/var/lib/games-vault/RELEASE_MANIFEST.json"))
}

fn load_release_manifest() -> Option<ReleaseManifest> {
    let content = std::fs::read_to_string(release_manifest_path()).ok()?;
    serde_json::from_str(&content).ok()
}

fn normalize_binary_path(path: &str) -> String {
    std::fs::canonicalize(path)
        .unwrap_or_else(|_| PathBuf::from(path))
        .display()
        .to_string()
}

fn component_version(
    package_version: &str,
    binary_path: Option<String>,
    manifest: Option<&ReleaseManifest>,
    artifact: Option<&ReleaseArtifactManifest>,
) -> gv_web::ComponentVersion {
    gv_web::ComponentVersion {
        package_version: package_version.to_string(),
        git_sha: manifest.and_then(|m| m.git_sha.clone()),
        artifact_sha256: artifact.and_then(|a| a.sha256.clone()),
        built_at_utc: manifest.and_then(|m| m.built_at_utc.clone()),
        released_at_utc: manifest.and_then(|m| m.released_at_utc.clone()),
        binary_path,
    }
}

fn collect_component_versions(cfg: &config::Config) -> gv_web::VersionMetadata {
    let manifest = load_release_manifest();
    let manifest_ref = manifest.as_ref();
    let artifacts = manifest_ref.and_then(|m| m.artifacts.as_ref());
    let worker_bin = worker::resolve_worker_bin(cfg.gv_web.worker_bin.as_deref());

    gv_web::VersionMetadata {
        server: component_version(
            env!("CARGO_PKG_VERSION"),
            std::env::current_exe().ok().map(|p| p.display().to_string()),
            manifest_ref,
            artifacts.and_then(|a| a.gv_server.as_ref()),
        ),
        worker: component_version(
            env!("CARGO_PKG_VERSION"),
            Some(normalize_binary_path(&worker_bin)),
            manifest_ref,
            artifacts.and_then(|a| a.gv_worker.as_ref()),
        ),
        runner: component_version(
            libretro_runner::VERSION,
            None,
            manifest_ref,
            None,
        ),
    }
}

// ── Server metadata collection ────────────────────────────────────────

/// Collect non-secret server metadata for connectivity diagnostics.
/// LAN addresses, ROM roots, ICE config summary — no credentials.
pub(crate) fn collect_metadata(cfg: &config::Config) -> gv_web::ServerMetadata {
    let version = env!("CARGO_PKG_VERSION").to_string();
    let versions = collect_component_versions(cfg);

    // Collect local IP addresses for LAN connectivity diagnostics
    let lan_addresses: Vec<String> = std::iter::once(local_ip_address::local_ip())
        .flatten()
        .map(|ip| ip.to_string())
        .collect();

    let rom_roots: Vec<String> = cfg
        .rom
        .as_ref()
        .map(|r| r.roots.clone())
        .unwrap_or_default();

    // ICE metadata — summary only, no credentials
    let stun_urls: Vec<String> = std::env::var("GV_ICE_STUN_URLS")
        .ok()
        .map(|s| s.split(',').map(|p| p.trim().to_string()).filter(|p| !p.is_empty()).collect())
        .unwrap_or_default();

    let turn_urls: Vec<String> = std::env::var("GV_ICE_TURN_URLS")
        .ok()
        .map(|s| s.split(',').map(|p| p.trim().to_string()).filter(|p| !p.is_empty()).collect())
        .unwrap_or_default();

    let turn_username = std::env::var("GV_ICE_TURN_USERNAME").ok().unwrap_or_default();
    let turn_credential = std::env::var("GV_ICE_TURN_CREDENTIAL").ok().unwrap_or_default();
    let turn_configured = !turn_urls.is_empty() && !turn_username.is_empty() && !turn_credential.is_empty();

    let transport_policy = std::env::var("GV_ICE_TRANSPORT_POLICY")
        .ok()
        .unwrap_or_else(|| "all".to_string());

    let ice = gv_web::IceMetadata {
        stun_urls,
        turn_urls,
        turn_configured,
        transport_policy,
    };

    gv_web::ServerMetadata {
        version,
        versions,
        lan_addresses,
        rom_roots,
        ice,
    }
}

// ── Boot-time validation ──────────────────────────────────────────────

