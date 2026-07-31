//! ROM download over WebRTC DataChannel.
//!
//! Architecture: browser creates peer connection + SDP offer, sends it
//! to sc-server via a rom_download command. sc-server resolves the game,
//! creates a peer connection with a `rom-download-v1` DataChannel, sets
//! the browser's offer as remote, generates an SDP answer, and reports it
//! back. When the DataChannel opens, sc-server streams the file in chunks.

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

/// Stream the resolved ROM file to the browser over a DataChannel.
async fn stream_file(
    dc: &Arc<RTCDataChannel>,
    path: &std::path::Path,
    game_id: &str,
    file_size: u64,
) {
    let mut file = match tokio::fs::File::open(path).await {
        Ok(f) => f,
        Err(e) => {
            tracing::error!("[ROM DL] open failed for {game_id}: {e:#}");
            let _ = dc.send_text(r#"{"error":"cannot open file"}"#.to_string()).await;
            return;
        }
    };

    use tokio::io::AsyncReadExt;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; CHUNK_SIZE];
    let mut total_sent: u64 = 0;

    loop {
        match file.read(&mut buf).await {
            Ok(0) => break,
            Ok(n) => {
                hasher.update(&buf[..n]);
                if let Err(e) = dc.send(&bytes::Bytes::from(buf[..n].to_vec())).await {
                    tracing::error!("[ROM DL] send chunk failed: {e:#}");
                    return;
                }
                total_sent += n as u64;
            }
            Err(e) => {
                tracing::error!("[ROM DL] read error for {game_id}: {e:#}");
                return;
            }
        }
    }

    let hash = hex::encode(hasher.finalize());
    let complete = serde_json::json!({
        "done": true,
        "sha256": hash,
        "size": total_sent,
    });

    if let Err(e) = dc.send_text(complete.to_string()).await {
        tracing::error!("[ROM DL] send complete failed: {e:#}");
        return;
    }

    tracing::info!(
        "[ROM DL] complete: {total_sent} bytes (declared {file_size}), sha256={hash}",
    );
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

    let browser_sdp = match cmd.payload.get("sdp").and_then(|v| v.as_str()) {
        Some(s) => s.to_string(),
        None => {
            let _ = client
                .command_result(
                    &cmd.id,
                    &cmd.lease_token,
                    &serde_json::json!({"ok": false, "error": "missing browser SDP offer"}),
                )
                .await;
            return;
        }
    };

    // Resolve the game
    let games = local_game_list.read().await;
    let (path, name, size) = match storage::resolve_download(&game_id, rom_roots, &games) {
        Ok(r) => (r.path.clone(), r.name.clone(), r.size),
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
    drop(games);

    tracing::info!(
        "[ROM DL] game_id={game_id} path={} size={size}",
        path.display(),
    );

    // Build PC and create DataChannel (we're the answerer)
    let pc = match build_download_pc().await {
        Ok(pc) => Arc::new(pc),
        Err(e) => {
            let _ = client
                .command_result(&cmd.id, &cmd.lease_token, &serde_json::json!({"ok": false, "error": format!("peer connection failed: {e}")}),
                )
                .await;
            return;
        }
    };

    // Set browser's offer as remote description
    let offer_desc = match webrtc::peer_connection::sdp::session_description::RTCSessionDescription::offer(
        browser_sdp,
    ) {
        Ok(d) => d,
        Err(e) => {
            let _ = client
                .command_result(&cmd.id, &cmd.lease_token, &serde_json::json!({"ok": false, "error": format!("invalid SDP offer: {e}")}),
                )
                .await;
            return;
        }
    };

    if let Err(e) = pc.set_remote_description(offer_desc).await {
        let _ = client
            .command_result(&cmd.id, &cmd.lease_token, &serde_json::json!({"ok": false, "error": format!("set remote desc failed: {e}")}),
            )
            .await;
        return;
    }

    // Wait for the browser's DataChannel to arrive, then stream
    let (dc_tx, mut dc_rx) = tokio::sync::mpsc::channel::<Arc<RTCDataChannel>>(1);

    pc.on_data_channel(Box::new(move |dc| {
        let dc_tx = dc_tx.clone();
        Box::pin(async move {
            if dc.label() == DC_LABEL {
                let _ = dc_tx.try_send(dc);
            }
        })
    }));

    // Create answer (we're the answerer — DC arrives from browser's offer)
    let answer = match pc.create_answer(None).await {
        Ok(a) => a,
        Err(e) => {
            let _ = client
                .command_result(&cmd.id, &cmd.lease_token, &serde_json::json!({"ok": false, "error": format!("create answer failed: {e}")}),
                )
                .await;
            return;
        }
    };

    if let Err(e) = pc.set_local_description(answer).await {
        let _ = client
            .command_result(&cmd.id, &cmd.lease_token, &serde_json::json!({"ok": false, "error": format!("set local desc failed: {e}")}),
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
                .command_result(&cmd.id, &cmd.lease_token, &serde_json::json!({"ok": false, "error": "ICE gathering timed out"}),
                )
                .await;
            return;
        }
    }

    tokio::time::sleep(Duration::from_millis(200)).await;

    let answer_sdp = match pc.local_description().await {
        Some(desc) => desc.sdp,
        None => {
            let _ = client
                .command_result(&cmd.id, &cmd.lease_token, &serde_json::json!({"ok": false, "error": "no local description"}),
                )
                .await;
            return;
        }
    };

    // Report SDP answer + game metadata to sc-web
    if let Err(e) = client
        .command_result(
            &cmd.id,
            &cmd.lease_token,
            &serde_json::json!({
                "ok": true,
                "sdp": answer_sdp,
                "game_id": game_id,
                "name": name,
                "size": size,
            }),
        )
        .await
    {
        tracing::error!("[ROM DL] failed to report SDP answer: {e:#}");
        return;
    }

    tracing::info!("[ROM DL] SDP answer delivered for game_id={game_id}");

    // Wait for the browser's DataChannel to arrive and open, then stream
    match tokio::time::timeout(Duration::from_secs(60), dc_rx.recv()).await {
        Ok(Some(dc)) => {
            let (opened_tx, mut opened_rx) = tokio::sync::mpsc::channel::<()>(1);
            dc.on_open(Box::new(move || {
                let opened_tx = opened_tx.clone();
                Box::pin(async move {
                    let _ = opened_tx.try_send(());
                })
            }));

            match tokio::time::timeout(Duration::from_secs(30), opened_rx.recv()).await {
                Ok(Some(())) => {
                    tracing::info!("[ROM DL] DataChannel open, streaming for game_id={game_id}");
                    stream_file(&dc, &path, &game_id, size).await;
                }
                _ => {
                    tracing::warn!("[ROM DL] DataChannel did not open within 30s for game_id={game_id}");
                }
            }
        }
        _ => {
            tracing::warn!("[ROM DL] no DataChannel received within 60s for game_id={game_id}");
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
