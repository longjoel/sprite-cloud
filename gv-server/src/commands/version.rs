//! Server metadata collection for gv-web pairing.
//!
//! Collects version and connectivity metadata at startup
//! for reporting to gv-web during server verification.

use crate::config;
use crate::gv_web;

fn lan_metadata(interfaces: &[gv_web::InterfaceInfo], player_port: u16) -> gv_web::LanMetadata {
    let player_urls = interfaces
        .iter()
        .map(|iface| format!("http://{}:{}/", iface.address, player_port))
        .collect::<Vec<_>>();
    let health_urls = interfaces
        .iter()
        .map(|iface| format!("http://{}:{}/health", iface.address, player_port))
        .collect::<Vec<_>>();

    gv_web::LanMetadata {
        player_port,
        player_urls,
        health_urls,
    }
}

/// Collect non-secret server metadata for connectivity diagnostics
/// and version reporting during pairing/startup verification.
pub(crate) async fn collect_metadata(cfg: &config::Config) -> gv_web::ServerMetadata {
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

    let interfaces: Vec<gv_web::InterfaceInfo> = if_addrs::get_if_addrs()
        .ok()
        .into_iter()
        .flatten()
        .filter(|iface| !iface.is_loopback())
        .filter(|iface| iface.addr.ip().is_ipv4())
        .map(|iface| gv_web::InterfaceInfo {
            name: iface.name,
            address: iface.addr.ip().to_string(),
        })
        .collect();

    let public_ip = detect_public_ip().await;

    let rom_roots: Vec<String> = cfg
        .rom
        .as_ref()
        .map(|r| r.roots.clone())
        .unwrap_or_default();

    let ice_cfg = config::runtime_ice_config();
    let ice = gv_web::IceMetadata {
        stun_url_count: ice_cfg.effective_stun_urls().len(),
        turn_url_count: ice_cfg.turn_urls.len(),
        stun_urls: ice_cfg.effective_stun_urls(),
        turn_urls: ice_cfg.turn_urls.clone(),
        turn_configured: ice_cfg.turn_ready(),
        turn_username_present: ice_cfg.turn_username_present,
        turn_credential_present: ice_cfg.turn_credential_present,
        transport_policy: ice_cfg.transport_policy.as_str().to_string(),
        status: ice_cfg.status.as_str().to_string(),
        defaulted_to_public_stun: ice_cfg.defaulted_to_public_stun,
    };

    let runtime = gv_web::RuntimeMetadata {
        pc_pool_size: std::env::var("GV_PC_POOL_SIZE")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(2),
        video_scale_height: config::gst_video_scale_height(),
        video_max_scale: config::gst_video_max_scale(),
    };

    let lan = lan_metadata(&interfaces, config::player_port());

    gv_web::ServerMetadata {
        version: env!("CARGO_PKG_VERSION").to_string(),
        versions,
        interfaces,
        public_ip,
        rom_roots,
        ice,
        runtime,
        lan,
    }
}

async fn detect_public_ip() -> Option<String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(5))
        .build()
        .ok()?;
    let resp = client.get("https://api.ipify.org").send().await.ok()?;
    resp.text().await.ok().map(|s| s.trim().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lan_metadata_builds_player_and_health_urls_for_each_interface() {
        let interfaces = vec![
            gv_web::InterfaceInfo {
                name: "eth0".to_string(),
                address: "192.168.86.128".to_string(),
            },
            gv_web::InterfaceInfo {
                name: "tailscale0".to_string(),
                address: "100.64.0.10".to_string(),
            },
        ];

        let lan = lan_metadata(&interfaces, 8787);

        assert_eq!(lan.player_port, 8787);
        assert_eq!(
            lan.player_urls,
            vec![
                "http://192.168.86.128:8787/".to_string(),
                "http://100.64.0.10:8787/".to_string(),
            ]
        );
        assert_eq!(
            lan.health_urls,
            vec![
                "http://192.168.86.128:8787/health".to_string(),
                "http://100.64.0.10:8787/health".to_string(),
            ]
        );
    }
}
