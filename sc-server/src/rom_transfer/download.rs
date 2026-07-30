//! ROM download over WebRTC DataChannel.
//!
//! Architecture: server creates a minimal peer connection with a
//! `rom-download-v1` DataChannel, generates an SDP offer, reports it
//! to sc-web, then streams the resolved ROM file to the browser in
//! 256 KiB chunks with a trailing SHA256 hash.

use crate::rom_transfer::storage;
use crate::sc_web;
use sha2::{Digest, Sha256};
use std::sync::Arc;
use std::time::Duration;
use webrtc::api::APIBuilder;
use webrtc::api::interceptor_registry::register_default_interceptors;
use webrtc::api::media_engine::MediaEngine;
use webrtc::api::setting_engine::SettingEngine;
use webrtc::data_channel::RTCDataChannel;
use webrtc::ice::mdns::MulticastDnsMode;
use webrtc::ice::network_type::NetworkType;
use webrtc::peer_connection::configuration::RTCConfiguration;
use webrtc::peer_connection::RTCPeerConnection;

const DC_LABEL: &str = "rom-download-v1";
const CHUNK_SIZE: usize = 256 * 1024;
const ICE_GATHERING_TIMEOUT_SECS: u64 = 30;

/// Response sent to sc-web after the SDP offer is ready.
/// The browser picks this up and connects.
#[derive(serde::Serialize)]
struct DownloadOfferResponse {
    ok: bool,
    sdp: String,
    game_id: String,
    name: String,
    size: u64,
    waiting_for_answer: bool,
}

/// Read the file and send it chunk-by-chunk over the DataChannel.
/// Returns on completion or error.
async fn stream_file_to_dc(
    dc: &Arc<RTCDataChannel>,
    path: &std::path::Path,
) -> Result<(), String> {
    use std::io::Read;

    let mut file = std::fs::File::open(path)
        .map_err(|e| format!("cannot open file: {e}"))?;
    let file_size = file.metadata().map(|m| m.len()).unwrap_or(0);

    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; CHUNK_SIZE];
    let mut total_sent: u64 = 0;

    loop {
        let n = file.read(&mut buf).map_err(|e| format!("read error: {e}"))?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);

        dc.send(&bytes::Bytes::from(buf[..n].to_vec()))
            .await
            .map_err(|e| format!("send chunk error: {e}"))?;

        total_sent += n as u64;
    }

    let hash = hex::encode(hasher.finalize());

    let complete = serde_json::json!({
        "done": true,
        "sha256": hash,
        "size": total_sent,
    });
    dc.send_text(complete.to_string())
        .await
        .map_err(|e| format!("send complete error: {e}"))?;

    tracing::info!(
        "[ROM DL] complete: {total_sent} bytes (declared {file_size}), sha256={hash}",
    );

    Ok(())
}

pub(crate) async fn handle_rom_download(
    cmd: &sc_web::Command,
    client: &sc_web::ScWebClient,
    rom_roots: &[String],
    local_game_list: Arc<tokio::sync::RwLock<Vec<crate::player_server::LocalGame>>>,
) {
    let game_id = match cmd.payload.get("game_id").and_then(|v| v.as_str()) {
        Some(id) => id.to_string(),
        None => {
            let _ = client
                .command_result(
                    &cmd.id,
                    &cmd.lease_token,
                    &serde_json::json!({"ok": false, "error": "missing game_id"}),
                )
                .await;
            return;
        }
    };

    // Resolve the game — reuses existing path safety
    let games = local_game_list.read().await;
    let resolved = match storage::resolve_download(&game_id, rom_roots, &games) {
        Ok(r) => r,
        Err(e) => {
            let _ = client
                .command_result(
                    &cmd.id,
                    &cmd.lease_token,
                    &serde_json::json!({"ok": false, "error": format!("{e:#}")}),
                )
                .await;
            return;
        }
    };
    let path = resolved.path.clone();
    let name = resolved.name.clone();
    let size = resolved.size;
    drop(games);

    tracing::info!(
        "[ROM DL] game_id={game_id} path={} size={size}",
        path.display(),
    );

    // Build a minimal PC (no tracks, just a DataChannel)
    let pc = match build_download_pc().await {
        Ok(pc) => Arc::new(pc),
        Err(e) => {
            let _ = client
                .command_result(
                    &cmd.id,
                    &cmd.lease_token,
                    &serde_json::json!({"ok": false, "error": format!("peer connection failed: {e}")}),
                )
                .await;
            return;
        }
    };

    // Create DataChannel before offer (so it appears in the SDP)
    let dc = match pc.create_data_channel(DC_LABEL, None).await {
        Ok(dc) => Arc::new(dc),
        Err(e) => {
            let _ = client
                .command_result(
                    &cmd.id,
                    &cmd.lease_token,
                    &serde_json::json!({"ok": false, "error": format!("data channel failed: {e}")}),
                )
                .await;
            return;
        }
    };

    // Create SDP offer, set local description
    let offer = match pc.create_offer(None).await {
        Ok(o) => o,
        Err(e) => {
            let _ = client
                .command_result(
                    &cmd.id,
                    &cmd.lease_token,
                    &serde_json::json!({"ok": false, "error": format!("create offer failed: {e}")}),
                )
                .await;
            return;
        }
    };

    if let Err(e) = pc.set_local_description(offer).await {
        let _ = client
            .command_result(
                &cmd.id,
                &cmd.lease_token,
                &serde_json::json!({"ok": false, "error": format!("set local desc failed: {e}")}),
            )
            .await;
        return;
    }

    // Wait for ICE gathering
    let (done_tx, mut done_rx) = tokio::sync::mpsc::channel::<()>(1);
    pc.on_ice_candidate(Box::new({
        let done_tx = done_tx.clone();
        move |candidate: Option<webrtc::ice_transport::ice_candidate::RTCIceCandidate>| {
            let done_tx = done_tx.clone();
            Box::pin(async move {
                if candidate.is_none() {
                    let _ = done_tx.try_send(());
                }
            })
        }
    }));

    match tokio::time::timeout(
        Duration::from_secs(ICE_GATHERING_TIMEOUT_SECS),
        done_rx.recv(),
    )
    .await
    {
        Ok(Some(())) => {}
        _ => {
            let _ = client
                .command_result(
                    &cmd.id,
                    &cmd.lease_token,
                    &serde_json::json!({"ok": false, "error": "ICE gathering timed out"}),
                )
                .await;
            return;
        }
    }

    tokio::time::sleep(Duration::from_millis(200)).await;

    let sdp_offer = match pc.local_description().await {
        Some(desc) => desc.sdp,
        None => {
            let _ = client
                .command_result(
                    &cmd.id,
                    &cmd.lease_token,
                    &serde_json::json!({"ok": false, "error": "no local description"}),
                )
                .await;
            return;
        }
    };

    // Report SDP offer to sc-web
    let response = DownloadOfferResponse {
        ok: true,
        sdp: sdp_offer,
        game_id: game_id.clone(),
        name,
        size,
        waiting_for_answer: true,
    };

    if let Err(e) = client
        .command_result(&cmd.id, &cmd.lease_token, &serde_json::json!(response))
        .await
    {
        tracing::error!("[ROM DL] failed to report SDP offer: {e:#}");
        return;
    }

    tracing::info!("[ROM DL] SDP offer delivered for game_id={game_id}");

    // Wait for DataChannel to open, then stream
    let (opened_tx, mut opened_rx) = tokio::sync::mpsc::channel::<()>(1);
    dc.on_open(Box::new(move || {
        let opened_tx = opened_tx.clone();
        Box::pin(async move {
            let _ = opened_tx.try_send(());
        })
    }));

    match tokio::time::timeout(Duration::from_secs(60), opened_rx.recv()).await {
        Ok(Some(())) => {
            tracing::info!("[ROM DL] DataChannel open, streaming for game_id={game_id}");

            match stream_file_to_dc(&dc, &path).await {
                Ok(()) => {
                    tracing::info!("[ROM DL] stream complete for game_id={game_id}");
                }
                Err(e) => {
                    tracing::error!("[ROM DL] stream failed for {game_id}: {e}");
                }
            }
        }
        _ => {
            tracing::warn!("[ROM DL] DataChannel did not open within 60s for game_id={game_id}");
        }
    }

    let _ = pc.close().await;
}

async fn build_download_pc() -> Result<RTCPeerConnection, String> {
    let mut media_engine = MediaEngine::default();
    media_engine
        .register_default_codecs()
        .map_err(|e| format!("register codecs: {e}"))?;

    let mut registry = webrtc::interceptor::registry::Registry::new();
    registry = register_default_interceptors(registry, &mut media_engine)
        .map_err(|e| format!("interceptors: {e}"))?;

    let mut se = SettingEngine::default();
    se.set_ip_filter(Box::new(|ip: std::net::IpAddr| ip.is_ipv4()));
    se.set_network_types(vec![NetworkType::Udp4, NetworkType::Tcp4]);
    se.set_ice_multicast_dns_mode(MulticastDnsMode::QueryOnly);

    let api = APIBuilder::new()
        .with_setting_engine(se)
        .with_media_engine(media_engine)
        .with_interceptor_registry(registry)
        .build();

    let ice_cfg = crate::config::runtime_ice_config();
    let mut ice_servers: Vec<webrtc::ice_transport::ice_server::RTCIceServer> = Vec::new();

    for url in ice_cfg.effective_stun_urls() {
        ice_servers.push(webrtc::ice_transport::ice_server::RTCIceServer {
            urls: vec![url],
            username: String::new(),
            credential: String::new(),
        });
    }
    for url in &ice_cfg.turn_urls {
        ice_servers.push(webrtc::ice_transport::ice_server::RTCIceServer {
            urls: vec![url.clone()],
            username: ice_cfg.turn_username.clone().unwrap_or_default(),
            credential: ice_cfg.turn_credential.clone().unwrap_or_default(),
        });
    }

    let ice_policy = match ice_cfg.transport_policy {
        crate::config::IceTransportPolicySetting::All => {
            webrtc::peer_connection::policy::ice_transport_policy::RTCIceTransportPolicy::All
        }
        crate::config::IceTransportPolicySetting::Relay => {
            webrtc::peer_connection::policy::ice_transport_policy::RTCIceTransportPolicy::Relay
        }
    };

    api.new_peer_connection(RTCConfiguration {
        ice_servers,
        ice_transport_policy: ice_policy,
        ..Default::default()
    })
    .await
    .map_err(|e| format!("peer connection: {e}"))
}
