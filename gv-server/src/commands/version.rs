//! Server metadata collection for gv-web pairing.
//!
//! Collects version and connectivity metadata at startup
//! for reporting to gv-web during server verification.

use crate::config;
use crate::gv_web;

/// Collect non-secret server metadata for connectivity diagnostics
/// and version reporting during pairing/startup verification.
pub(crate) fn collect_metadata(cfg: &config::Config) -> gv_web::ServerMetadata {
    let pkg_version = env!("CARGO_PKG_VERSION").to_string();

    let server_bin = std::env::current_exe()
        .ok()
        .map(|p| p.display().to_string());

    let server_version = gv_web::ComponentVersion {
        package_version: pkg_version.clone(),
        git_sha: None,
        artifact_sha256: None,
        built_at_utc: None,
        released_at_utc: None,
        binary_path: server_bin,
    };

    let versions = gv_web::VersionMetadata {
        server: server_version,
        worker: gv_web::ComponentVersion {
            package_version: pkg_version,
            git_sha: None,
            artifact_sha256: None,
            built_at_utc: None,
            released_at_utc: None,
            binary_path: None,
        },
        runner: gv_web::ComponentVersion {
            package_version: libretro_runner::VERSION.to_string(),
            git_sha: None,
            artifact_sha256: None,
            built_at_utc: None,
            released_at_utc: None,
            binary_path: None,
        },
    };

    let lan_addresses: Vec<String> = std::iter::once(local_ip_address::local_ip())
        .flatten()
        .map(|ip| ip.to_string())
        .collect();

    let rom_roots: Vec<String> = cfg
        .rom
        .as_ref()
        .map(|r| r.roots.clone())
        .unwrap_or_default();

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
        version: env!("CARGO_PKG_VERSION").to_string(),
        versions,
        lan_addresses,
        rom_roots,
        ice,
    }
}
