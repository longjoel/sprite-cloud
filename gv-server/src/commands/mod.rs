//! CLI subcommand implementations: `pair` and `start`.
//!
//! `start` polls gv-web via HTTP (same as before), but game sessions now
//! run in-process — no gv-worker binary, no shm IPC, no cross-process spawn.

use anyhow::{Context, Result};
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use crate::config;
use crate::core_bridge;
use crate::dat;
use crate::gv_web;
use crate::scan;
use crate::session::GameSession;
use crate::streaming;
use crate::webrtc;
pub(crate) use version::collect_metadata;
pub(crate) mod version;

// ── pair subcommand ─────────────────────────────────────────────────

pub(crate) async fn cmd_pair(code: &str, gv_web_url: &str) -> Result<()> {
    tracing::info!("Pairing with {} ...", gv_web_url);

    let rom_roots: Vec<String> = std::env::var("GV_ROM_ROOTS")
        .ok()
        .map(|s| {
            s.split(',')
                .map(|p| p.trim().to_string())
                .filter(|p| !p.is_empty())
                .collect()
        })
        .unwrap_or_default();

    if !rom_roots.is_empty() {
        tracing::info!("  rom_roots: {:?}", rom_roots);
    }

    let hostname = std::fs::read_to_string("/proc/sys/kernel/hostname")
        .map(|s| s.trim().to_string())
        .unwrap_or_else(|_| "unknown".to_string());

    let resp = gv_web::GvWebClient::claim(code, gv_web_url, rom_roots.clone(), &hostname).await?;

    let cfg = config::Config {
        gv_web: config::GvWeb {
            url: gv_web_url.to_string(),
            worker_bin: std::env::var("GV_WORKER_BIN").ok(),
        },
        auth: config::Auth {
            api_key: resp.api_key.clone(),
            server_id: resp.server_id.clone(),
        },
        rom: if rom_roots.is_empty() {
            None
        } else {
            Some(config::Rom { roots: rom_roots })
        },
    };

    config::save(&cfg).context("save config")?;

    tracing::info!("Paired!");
    tracing::info!("  server_id: {}", resp.server_id);
    tracing::info!("  api_key:   {}", &resp.api_key[..8.min(resp.api_key.len())]);
    tracing::info!("  config saved");

    Ok(())
}

// ── start subcommand (HTTP polling, in-process sessions) ────────────

pub(crate) async fn cmd_start(gv_web_url: Option<String>) -> Result<()> {
    let mut cfg = config::load().context("load config (run 'gv-server pair' first)")?;

    if let Some(url) = gv_web_url {
        cfg.gv_web.url = url;
    }

    let client = gv_web::GvWebClient::new(cfg.gv_web.url.clone(), cfg.auth.clone());

    // Verify API key
    let metadata = collect_metadata(&cfg);
    let verify = match client.verify_with_metadata(&metadata).await {
        Ok(v) => v,
        Err(e) => {
            let msg = format!("{e:#}");
            if msg.contains("401") || msg.contains("unauthorized") {
                tracing::error!("[AUTH] API key rejected — re-pair with: gv-server pair <CODE>");
                std::process::exit(2);
            }
            return Err(e);
        }
    };
    tracing::info!(
        "Connected to gv-web as server {} (user: {})",
        verify.server_id,
        verify.user_id
    );

    // GStreamer init (only once at startup)
    gstreamer::init().expect("GStreamer init failed");
    tracing::info!("GStreamer initialized");

    // ROM roots
    let rom_roots: Vec<String> = cfg
        .rom
        .as_ref()
        .map(|r| r.roots.clone())
        .unwrap_or_default();

    // Pre-warm ICE
    webrtc::prewarm_ice_agent().await;

    tracing::info!("gv-server running — polling for commands...");

    const POLL_ERROR_BACKOFF_MS: u64 = 5_000;
    let mut sessions: HashMap<String, Arc<GameSession>> = HashMap::new();

    let scan_lock: Arc<tokio::sync::Mutex<()>> = Arc::new(tokio::sync::Mutex::new(()));
    let dat_index: Arc<tokio::sync::RwLock<Option<dat::DatIndex>>> =
        Arc::new(tokio::sync::RwLock::new(None));

    loop {
        tokio::select! {
            _ = shutdown_signal() => {
                tracing::info!("[SHUTDOWN] stopping all sessions...");
                for (gid, s) in &sessions {
                    s.cancel.cancel();
                    tracing::info!("[SHUTDOWN] cancelled session {gid}");
                }
                break;
            }
            _ = async {
                match client.poll().await {
                    Ok(resp) => {
                        if !resp.commands.is_empty() {
                            for cmd in &resp.commands {
                                tracing::info!(
                                    "[POLL] command {}: {} {}",
                                    cmd.id,
                                    cmd.command_type,
                                    cmd.payload,
                                );

                                if cmd.command_type == "start_game" {
                                    handle_start_game(
                                        cmd, &client, &mut sessions,
                                        &rom_roots,
                                    ).await;
                                } else if cmd.command_type == "stop_game" {
                                    handle_stop_game(cmd, &client, &mut sessions).await;
                                } else if cmd.command_type == "sdp_offer" {
                                    handle_sdp_offer(
                                        cmd, &client, &sessions,
                                    ).await;
                                } else if cmd.command_type == "browse_files" {
                                    handle_browse_files(cmd, &client, &rom_roots).await;
                                } else if cmd.command_type == "scan_paths" {
                                    handle_scan_paths(
                                        cmd, &client, &rom_roots,
                                        &scan_lock, &dat_index,
                                    ).await;
                                }
                            }
                        }

                        // Dead session cleanup
                        let mut dead: Vec<String> = Vec::new();
                        for (gid, s) in sessions.iter() {
                            if s.cancel.is_cancelled() {
                                dead.push(gid.clone());
                            }
                        }
                        for gid in &dead {
                            sessions.remove(gid);
                            let _ = client.notify_worker_dead(gid, None).await;
                        }

                        tokio::time::sleep(Duration::from_millis(resp.next_poll_ms)).await;
                    }
                    Err(e) => {
                        tracing::error!("[POLL] error: {:#}", e);
                        tokio::time::sleep(Duration::from_millis(POLL_ERROR_BACKOFF_MS)).await;
                    }
                }
            } => {}
        }
    }

    for (gid, s) in &sessions {
        s.cancel.cancel();
        tracing::info!("[SHUTDOWN] cancelled session {gid}");
    }

    tracing::info!("[SHUTDOWN] done");
    Ok(())
}

// ── Command handlers ────────────────────────────────────────────────

async fn handle_start_game(
    cmd: &gv_web::Command,
    client: &gv_web::GvWebClient,
    sessions: &mut HashMap<String, Arc<GameSession>>,
    rom_roots: &[String],
) {
    let game_id = cmd.payload.get("game_id").and_then(|v| v.as_str()).unwrap_or("unknown");
    let session_id = cmd.payload.get("session_id").and_then(|v| v.as_str()).unwrap_or("");
    let host_token = cmd.payload.get("host_token").and_then(|v| v.as_str());
    let platform = cmd.payload.get("platform").and_then(|v| v.as_str());
    let rom_path = cmd.payload.get("rom_path").and_then(|v| v.as_str());
    let sdp_offer = cmd.payload.get("sdp").and_then(|v| v.as_str());

    tracing::info!("[POLL] start_game game={game_id} session={session_id} sdp={}", sdp_offer.is_some());

    // Kill existing session for this game_id
    if let Some(old) = sessions.remove(game_id) {
        tracing::info!("[SESSION] killing previous session for {game_id}");
        old.cancel.cancel();
    }

    // Resolve ROM path
    let content_path = rom_path.and_then(|rel| {
        for root in rom_roots {
            let full = std::path::Path::new(root).join(rel);
            if full.exists() {
                return Some(full.to_string_lossy().to_string());
            }
        }
        tracing::warn!("[SESSION] rom_path not found: {rel}");
        None
    });

    // Resolve (and download if needed) core from platform
    let core_path = match platform
        .and_then(|p| crate::platform::core_for_platform(p))
    {
        Some(core_file) => {
            match core_bridge::ensure_core(core_file, client.http_client()).await {
                Ok(path) => {
                    tracing::info!("[SESSION] core resolved: {}", path.display());
                    Some(path)
                }
                Err(e) => {
                    tracing::warn!("[SESSION] core download failed for {core_file}: {e} — will use test pattern");
                    None
                }
            }
        }
        None => None,
    };

    // Build WebRTC stack
    let stack = match webrtc::build_session_pc().await {
        Ok(s) => s,
        Err(e) => {
            tracing::error!("[SESSION] build_session_pc failed: {e}");
            let _ = client.command_result(
                &cmd.id, &cmd.lease_token,
                &serde_json::json!({"error": "webrtc_build_failed", "message": e}),
            ).await;
            return;
        }
    };

    // Create session
    let session = Arc::new(GameSession {
        game_id: game_id.to_string(),
        session_id: session_id.to_string(),
        cancel: tokio_util::sync::CancellationToken::new(),
        pc: stack.pc,
        video_track: stack.video_track,
        audio_track: stack.audio_track,
        core_loaded: std::sync::atomic::AtomicBool::new(false),
        core_loading: std::sync::atomic::AtomicBool::new(false),
        core_ready_notify: tokio::sync::Notify::new(),
        core_cmd_tx: tokio::sync::Mutex::new(None),
        core_frame_rx: tokio::sync::Mutex::new(None),
        core_response_rx: tokio::sync::Mutex::new(None),
        video_enc: tokio::sync::Mutex::new(None),
        audio_enc: tokio::sync::Mutex::new(None),
        core_width: tokio::sync::Mutex::new(0),
        core_height: tokio::sync::Mutex::new(0),
        core_fps: tokio::sync::Mutex::new(0.0),
        frames_encoded: std::sync::atomic::AtomicU64::new(0),
    });

    // Load libretro core
    core_bridge::load_core_into_session(
        &session,
        core_path.as_deref(),
        content_path.as_deref(),
        platform,
    ).await;

    let worker_url = format!("http://gv-worker.local/{game_id}");

    // Wire browser DC (non-negotiated, created by browser as "diagnostics")
    // → core commands. Uses on_data_channel on the PC.
    {
        let session = Arc::clone(&session);
        let pc = Arc::clone(&session.pc);
        pc.on_data_channel(Box::new(move |dc: Arc<_>| {
            let session = Arc::clone(&session);
            Box::pin(async move {
                tracing::info!("[DC] browser data channel received: {}", dc.label());

                // Clone Arc before setting up handlers (each handler needs its own ref)
                let dc_for_open = Arc::clone(&dc);
                let dc_for_msg = Arc::clone(&dc);
                let session_for_msg = Arc::clone(&session);

                dc_for_open.on_open(Box::new(move || {
                    tracing::info!("[DC] browser channel opened");
                    Box::pin(async {})
                }));

                let dc_for_move = Arc::clone(&dc_for_msg);
                dc_for_msg.on_message(Box::new(move |msg| {
                    let session = Arc::clone(&session_for_msg);
                    let dc = Arc::clone(&dc_for_move);
                    Box::pin(async move {
                        let data = if msg.is_string {
                            String::from_utf8_lossy(&msg.data).into_owned().into_bytes()
                        } else {
                            msg.data.to_vec()
                        };
                        tracing::info!("[DC] browser msg: {} bytes is_string={}", data.len(), msg.is_string);

                        // Try JSON (auth handshake first)
                        if let Ok(val) = serde_json::from_slice::<serde_json::Value>(&data) {
                            if val.get("cmd").and_then(|v| v.as_str()) == Some("auth") {
                                tracing::info!("[DC] auth received, sending ack");
                                // Send auth response so browser can start sending input
                                let ack = serde_json::json!({"cmd": "auth_ok"});
                                let _ = dc.send_text(ack.to_string()).await;
                                return;
                            }
                        }

                        // Binary input: [seat, state_lo, state_hi]
                        if data.len() >= 3 {
                            let seat = data[0] as u32;
                            let state = data[1] as u16 | ((data[2] as u16) << 8);
                            let guard = session.core_cmd_tx.lock().await;
                            if let Some(ref tx) = *guard {
                                let _ = tx.try_send(core_bridge::CoreCommand::SetInput {
                                    port: seat,
                                    state,
                                });
                            }
                        }
                    })
                }));
            })
        }));
    }

    // Spawn streaming loop
    let stream_session = Arc::clone(&session);
    let stream_cancel = session.cancel.clone();
    tokio::spawn(async move {
        streaming::run_stream(stream_session).await;
    });

    // Store session (clone before moving into HashMap)
    sessions.insert(game_id.to_string(), Arc::clone(&session));

    // Notify gv-web — include SDP answer if offer was provided
    if let Some(offer) = sdp_offer {
        let pc = Arc::clone(&session.pc);
        match webrtc::exchange_sdp_on_pc(&pc, offer).await {
            Ok(answer_sdp) => {
                tracing::info!("[SESSION] SDP exchange done ({} chars)", answer_sdp.len());
                if let Err(e) = client
                    .notify_sdp(&cmd.id, &cmd.lease_token, &worker_url, game_id, &answer_sdp, Some(session_id))
                    .await
                {
                    tracing::error!("[NOTIFY] notify_sdp failed: {e:#}");
                } else {
                    tracing::info!("[SESSION] game ready with SDP: {game_id}");
                }
            }
            Err(e) => {
                tracing::error!("[SESSION] SDP exchange failed: {e}");
                let _ = client.command_result(
                    &cmd.id, &cmd.lease_token,
                    &serde_json::json!({"error": "sdp_handshake_failed", "message": e}),
                ).await;
                return;
            }
        }
    } else {
        if let Err(e) = client
            .notify(&cmd.id, &cmd.lease_token, &worker_url, game_id, Some(session_id))
            .await
        {
            tracing::error!("[NOTIFY] failed: {e:#}");
        } else {
            tracing::info!("[SESSION] game ready: {game_id}");
        }
    }
}

async fn handle_stop_game(
    cmd: &gv_web::Command,
    client: &gv_web::GvWebClient,
    sessions: &mut HashMap<String, Arc<GameSession>>,
) {
    let game_id = cmd.payload.get("game_id").and_then(|v| v.as_str()).unwrap_or("unknown");
    tracing::info!("[POLL] stop_game game={game_id}");

    if let Some(session) = sessions.remove(game_id) {
        session.cancel.cancel();
        let session_id = cmd.payload.get("session_id").and_then(|v| v.as_str());
        let _ = client.notify_stop(&cmd.id, &cmd.lease_token, game_id, session_id).await;
    }
}

async fn handle_sdp_offer(
    cmd: &gv_web::Command,
    client: &gv_web::GvWebClient,
    sessions: &HashMap<String, Arc<GameSession>>,
) {
    let sdp = cmd.payload.get("sdp").and_then(|v| v.as_str()).unwrap_or("");
    let game_id = cmd.payload.get("game_id").and_then(|v| v.as_str()).unwrap_or("unknown");

    if sdp.is_empty() {
        tracing::warn!("[SDP] empty offer — ignoring");
        return;
    }

    tracing::info!("[SDP] offer for game {game_id} ({} chars)", sdp.len());

    // Wait for session to appear (core loading may take a moment)
    let started = std::time::Instant::now();
    let max_wait = Duration::from_secs(30);
    loop {
        if let Some(session) = sessions.get(game_id) {
            let pc = Arc::clone(&session.pc);
            match webrtc::exchange_sdp_on_pc(&pc, sdp).await {
                Ok(answer_sdp) => {
                    let worker_url = format!("http://gv-worker.local/{game_id}");
                    let session_id = cmd.payload.get("session_id").and_then(|v| v.as_str());
                    if let Err(e) = client
                        .notify_sdp(&cmd.id, &cmd.lease_token, &worker_url, game_id, &answer_sdp, session_id)
                        .await
                    {
                        tracing::error!("[SDP] notify_sdp failed: {e:#}");
                    } else {
                        tracing::info!("[SDP] answer sent ({}) chars", answer_sdp.len());
                    }
                }
                Err(e) => {
                    tracing::error!("[SDP] exchange failed: {e}");
                    let _ = client.command_result(
                        &cmd.id, &cmd.lease_token,
                        &serde_json::json!({"error": "sdp_handshake_failed", "message": e}),
                    ).await;
                }
            }
            return;
        }

        if started.elapsed() >= max_wait {
            tracing::warn!("[SDP] no session for game {game_id} after {:?}", started.elapsed());
            let _ = client.command_result(
                &cmd.id, &cmd.lease_token,
                &serde_json::json!({"error": "session_not_ready", "message": "session not ready"}),
            ).await;
            return;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

async fn handle_browse_files(
    cmd: &gv_web::Command,
    client: &gv_web::GvWebClient,
    rom_roots: &[String],
) {
    let path = cmd.payload.get("path").and_then(|v| v.as_str()).unwrap_or("");

    let tree = match scan::resolve_within_roots(std::path::Path::new(path), rom_roots) {
        Ok(resolved) => scan::browse_path(&resolved),
        Err(e) => scan::TreeNode {
            name: format!("Error: {e}"),
            node_type: "error".into(),
            children: vec![],
        },
    };

    let _ = client.command_result(
        &cmd.id, &cmd.lease_token,
        &serde_json::json!({"tree": tree}),
    ).await;
}

async fn handle_scan_paths(
    cmd: &gv_web::Command,
    client: &gv_web::GvWebClient,
    rom_roots: &[String],
    scan_lock: &Arc<tokio::sync::Mutex<()>>,
    dat_index: &Arc<tokio::sync::RwLock<Option<dat::DatIndex>>>,
) {
    let paths: Vec<String> = cmd.payload
        .get("paths")
        .and_then(|v| v.as_array())
        .map(|arr| arr.iter().filter_map(|v| v.as_str().map(String::from)).collect())
        .unwrap_or_default();

    if scan_lock.try_lock().is_err() {
        let _ = client.command_result(
            &cmd.id, &cmd.lease_token,
            &serde_json::json!({"error": "A scan is already in progress."}),
        ).await;
        return;
    }

    let _guard = scan_lock.lock().await;

    let mut all_files = Vec::new();
    for p in &paths {
        let resolved = match scan::resolve_within_roots(std::path::Path::new(p), rom_roots) {
            Ok(r) => r,
            Err(e) => {
                tracing::warn!("[SCAN] path rejected: {e:#}");
                continue;
            }
        };
        let mut files = scan::discover_roms(&resolved).unwrap_or_default();
        scan::hash_files(&mut files, &resolved);
        all_files.extend(files);
    }

    let mut dat_lock = dat_index.write().await;
    if dat_lock.is_none() {
        let mut combined: Option<dat::DatIndex> = None;
        let mut seen_exts = std::collections::HashSet::new();
        for file in &all_files {
            if let Some(ext) = file.relative_path.rsplit('.').next() {
                let ext_lower = ext.to_lowercase();
                if seen_exts.contains(&ext_lower) { continue; }
                seen_exts.insert(ext_lower.clone());
                if let Some(index) = dat::load_for_extension(
                    &ext_lower,
                    &dirs::cache_dir()
                        .unwrap_or_default()
                        .join("games-vault")
                        .join("dat"),
                ).await {
                    match &mut combined {
                        Some(c) => c.merge(index),
                        None => combined = Some(index),
                    }
                }
            }
        }
        *dat_lock = combined;
    }

    let mut matches = Vec::new();
    for file in &all_files {
        let dat_match = if let (Some(crc), Some(sha)) = (&file.crc, &file.sha256) {
            dat_lock.as_ref().and_then(|idx| dat::match_entry(idx, crc, sha))
                .map(|e| serde_json::json!({"name": e.canonical_name, "game_name": e.game_name}))
        } else { None };

        matches.push(serde_json::json!({"file": file, "match": dat_match}));
    }
    drop(dat_lock);

    let _ = client.command_result(
        &cmd.id, &cmd.lease_token,
        &serde_json::json!({"matches": matches}),
    ).await;
}

// ── Shutdown signal ─────────────────────────────────────────────────

#[cfg(unix)]
async fn shutdown_signal() {
    use tokio::signal::unix::{SignalKind, signal};
    let mut sigint = signal(SignalKind::interrupt()).expect("register SIGINT handler");
    let mut sigterm = signal(SignalKind::terminate()).expect("register SIGTERM handler");
    tokio::select! {
        _ = sigint.recv() => {},
        _ = sigterm.recv() => {},
    }
}

#[cfg(not(unix))]
async fn shutdown_signal() {
    tokio::signal::ctrl_c().await.expect("register Ctrl+C handler");
}
