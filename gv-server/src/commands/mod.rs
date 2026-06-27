//! CLI subcommand implementations: `pair` and `start`.
//!
//! `start` polls gv-web via HTTP (same as before), but game sessions now
//! run in-process — no separate runtime binary, no shm IPC, no cross-process spawn.

use anyhow::{Context, Result};
use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use crate::config;
use crate::core_bridge;
use crate::dat;
use crate::gv_web;
use crate::saves;

/// Build the worker HTTP URL using GV_WORKER_HOST env var (LAN IP) or fallback.
fn worker_url(game_id: &str) -> String {
    let host = std::env::var("GV_WORKER_HOST").unwrap_or_else(|_| "localhost".into());
    let port = std::env::var("GV_WORKER_PORT").unwrap_or_else(|_| "8787".into());
    format!("http://{host}:{port}/{game_id}")
}
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
        gv_web: config::GvWeb { url: gv_web_url.to_string() },
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

    // Pre-build PC pool
    let pool_size: usize = std::env::var("GV_PC_POOL_SIZE")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(2);
    let pc_pool = webrtc::PcPool::new(pool_size).await;

    tracing::info!("gv-server running — polling for commands...");

    // Start LAN player HTTP server (port 8787) for direct guest connections
    let player_addr: SocketAddr = std::env::var("GV_PLAYER_BIND")
        .unwrap_or_else(|_| "0.0.0.0:8787".into())
        .parse()
        .unwrap_or_else(|_| SocketAddr::from(([0, 0, 0, 0], 8787)));
    tokio::spawn(crate::player_server::serve(player_addr, cfg.gv_web.url.clone()));

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
                                        &rom_roots, &pc_pool,
                                    ).await;
                                } else if cmd.command_type == "stop_game" {
                                    handle_stop_game(cmd, &client, &mut sessions).await;
                                } else if cmd.command_type == "sdp_offer" {
                                    handle_sdp_offer(
                                        cmd, &client, &sessions, &pc_pool,
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
    pool: &webrtc::PcPool,
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

    // Acquire WebRTC stack from pool
    let stack = match pool.acquire().await {
        Ok(s) => s,
        Err(e) => {
            tracing::error!("[SESSION] pool.acquire failed: {e}");
            let _ = client.command_result(
                &cmd.id, &cmd.lease_token,
                &serde_json::json!({"error": "webrtc_build_failed", "message": e}),
            ).await;
            return;
        }
    };

    // Compute ROM hash for save persistence
    let rom_hash = content_path.as_deref()
        .and_then(|p| saves::hash_rom(std::path::Path::new(p)));

    // Create session
    let session = Arc::new(GameSession {
        game_id: game_id.to_string(),
        session_id: session_id.to_string(),
        cancel: tokio_util::sync::CancellationToken::new(),
        pc: std::sync::Mutex::new(stack.pc),
        video_track: std::sync::Mutex::new(stack.video_track),
        audio_track: std::sync::Mutex::new(stack.audio_track),
        dc: tokio::sync::Mutex::new(None),
        guests: tokio::sync::Mutex::new(Vec::new()),
        host_connected: std::sync::atomic::AtomicBool::new(false),
        local_players: std::sync::atomic::AtomicU32::new(1),
        core_loaded: std::sync::atomic::AtomicBool::new(false),
        core_loading: std::sync::atomic::AtomicBool::new(false),
        core_ready_notify: tokio::sync::Notify::new(),
        core_cmd_tx: tokio::sync::Mutex::new(None),
        core_frame_rx: tokio::sync::Mutex::new(None),
        core_response_rx: tokio::sync::Mutex::new(None),
        video_enc: tokio::sync::Mutex::new(None),
        audio_enc: tokio::sync::Mutex::new(None),
        rom_hash: tokio::sync::Mutex::new(rom_hash),
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

    let worker_url = worker_url(game_id);

    // Wire browser DC → core commands
    wire_dc_handler(&session);

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
        // SDP exchange with retry: first attempt on session PC,
        // then acquire fresh PC from pool and retry if needed
        let max_attempts = 2u32;
        let mut sdp_result = Err("no attempts".to_string());

        for attempt in 1..=max_attempts {
            let pc = session.pc.lock().unwrap().clone();
            let start = std::time::Instant::now();
            sdp_result = webrtc::exchange_sdp_on_pc(&pc, offer).await;
            let elapsed = start.elapsed();

            match &sdp_result {
                Ok(answer) => {
                    tracing::info!(
                        "[SESSION] SDP exchange OK on attempt {attempt} in {:?} ({} chars)",
                        elapsed, answer.len()
                    );
                    break;
                }
                Err(e) => {
                    tracing::warn!(
                        "[SESSION] SDP exchange attempt {attempt}/{max_attempts} failed in {:?}: {e}",
                        elapsed
                    );
                    if attempt < max_attempts {
                        // Acquire fresh PC from pool and swap into session
                        match pool.acquire().await {
                            Ok(fresh) => {
                                tracing::info!("[SESSION] SDP retry: swapped in fresh PC from pool");
                                // Swap tracks too — the streaming loop references them
                                *session.video_track.lock().unwrap() = fresh.video_track;
                                *session.audio_track.lock().unwrap() = fresh.audio_track;
                                *session.pc.lock().unwrap() = fresh.pc;
                                // Re-wire DC handler on the new PC
                                wire_dc_handler(&session);
                                tokio::time::sleep(Duration::from_millis(500)).await;
                            }
                            Err(e2) => {
                                tracing::error!("[SESSION] SDP retry: pool.acquire failed: {e2}");
                                break;
                            }
                        }
                    }
                }
            }
        }

        match sdp_result {
            Ok(answer_sdp) => {
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
                tracing::error!("[SESSION] SDP exchange failed after {max_attempts} attempts: {e}");
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
    pool: &webrtc::PcPool,
) {
    let sdp = cmd.payload.get("sdp").and_then(|v| v.as_str()).unwrap_or("");
    let game_id = cmd.payload.get("game_id").and_then(|v| v.as_str()).unwrap_or("unknown");
    let peer_token = cmd.payload.get("peer_token")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    if sdp.is_empty() {
        tracing::warn!("[SDP] empty offer — ignoring");
        return;
    }

    // ── Guest / Host dispatch ─────────────────────────────────────────
    // Guest SDP offers create a new PC — never touch the host's PC.
    let is_guest = cmd.payload.as_object().map_or(false, |obj| {
        obj.contains_key("peer_token") || obj.contains_key("room_token")
    });

    tracing::info!("[SDP] {} offer for game {game_id} ({} chars)",
        if is_guest { "guest" } else { "host" }, sdp.len());

    // Wait for session to appear (core loading may take a moment).
    // But if this is a host reconnection (host_token in SDP payload)
    // and the session is gone, fail fast — don't make the browser wait 30s.
    let started = std::time::Instant::now();
    let max_wait = Duration::from_secs(30);
    let has_host_token = cmd.payload.as_object()
        .map_or(false, |obj| obj.contains_key("host_token"));
    loop {
        if let Some(session) = sessions.get(game_id) {
            // ── Guest path: new PC from pool, never touch host PC ────
            if is_guest {
                handle_guest_sdp(session, sdp, &peer_token.unwrap_or_default(), cmd, client, pool).await;
                return;
            }

            // ── Host reconnection fast-path ─────────────────────────
            // If host_connected is false, the old PC is dead (DC close / ICE fail).
            // Skip it entirely — acquire fresh PC and do a clean exchange.
            let reconnecting = !session.host_connected.load(std::sync::atomic::Ordering::Relaxed);
            if reconnecting {
                tracing::info!("[SDP] host reconnecting — swapping in fresh PC");
                match pool.acquire().await {
                    Ok(fresh) => {
                        *session.video_track.lock().unwrap() = fresh.video_track;
                        *session.audio_track.lock().unwrap() = fresh.audio_track;
                        *session.pc.lock().unwrap() = fresh.pc;
                        wire_dc_handler(session);

                        match webrtc::exchange_sdp_on_pc(&session.pc.lock().unwrap().clone(), sdp).await {
                            Ok(answer_sdp) => {
                                tracing::info!("[SDP] reconnection exchange OK ({} chars)", answer_sdp.len());
                                let worker_url = worker_url(game_id);
                                let session_id = cmd.payload.get("session_id").and_then(|v| v.as_str());
                                let _ = client
                                    .notify_sdp(&cmd.id, &cmd.lease_token, &worker_url, game_id, &answer_sdp, session_id)
                                    .await;
                            }
                            Err(e) => {
                                tracing::error!("[SDP] reconnection exchange failed: {e}");
                                let _ = client.command_result(
                                    &cmd.id, &cmd.lease_token,
                                    &serde_json::json!({"error": "sdp_handshake_failed", "message": e}),
                                ).await;
                            }
                        }
                    }
                    Err(e) => {
                        tracing::error!("[SDP] reconnection pool.acquire failed: {e}");
                        let _ = client.command_result(
                            &cmd.id, &cmd.lease_token,
                            &serde_json::json!({"error": "pool_empty", "message": "no PCs available for reconnection"}),
                        ).await;
                    }
                }
                return;
            }

            // SDP exchange with retry
            let max_attempts = 2u32;
            let mut sdp_result = Err("no attempts".to_string());

            for attempt in 1..=max_attempts {
                let pc = session.pc.lock().unwrap().clone();
                let start = std::time::Instant::now();
                sdp_result = webrtc::exchange_sdp_on_pc(&pc, sdp).await;
                let elapsed = start.elapsed();

                match &sdp_result {
                    Ok(answer) => {
                        tracing::info!(
                            "[SDP] exchange OK on attempt {attempt} in {:?} ({} chars)",
                            elapsed, answer.len()
                        );
                        break;
                    }
                    Err(e) => {
                        tracing::warn!(
                            "[SDP] exchange attempt {attempt}/{max_attempts} failed in {:?}: {e}",
                            elapsed
                        );
                        if attempt < max_attempts {
                            match pool.acquire().await {
                                Ok(fresh) => {
                                    tracing::info!("[SDP] retry: swapped in fresh PC from pool");
                                    *session.video_track.lock().unwrap() = fresh.video_track;
                                    *session.audio_track.lock().unwrap() = fresh.audio_track;
                                    *session.pc.lock().unwrap() = fresh.pc;
                                    wire_dc_handler(session);
                                    tokio::time::sleep(Duration::from_millis(500)).await;
                                }
                                Err(e2) => {
                                    tracing::error!("[SDP] retry: pool.acquire failed: {e2}");
                                    break;
                                }
                            }
                        }
                    }
                }
            }

            match sdp_result {
                Ok(answer_sdp) => {
                    let worker_url = worker_url(game_id);
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
                    tracing::error!("[SDP] exchange failed after {max_attempts} attempts: {e}");
                    let _ = client.command_result(
                        &cmd.id, &cmd.lease_token,
                        &serde_json::json!({"error": "sdp_handshake_failed", "message": e}),
                    ).await;
                }
            }
            return;
        }

        if started.elapsed() >= max_wait || (has_host_token && started.elapsed() >= Duration::from_millis(100)) {
            let reason = if has_host_token { "session gone — server may have restarted" } else { "session not ready" };
            tracing::warn!("[SDP] no session for game {game_id}: {reason}");
            let _ = client.command_result(
                &cmd.id, &cmd.lease_token,
                &serde_json::json!({"error": "session_not_ready", "message": "session not ready"}),
            ).await;
            return;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

/// Guest SDP exchange — creates a new PC from pool, adds host tracks,
/// does SDP exchange on the guest PC, sends answer back.
async fn handle_guest_sdp(
    session: &Arc<GameSession>,
    sdp: &str,
    peer_token: &str,
    cmd: &gv_web::Command,
    client: &gv_web::GvWebClient,
    _pool: &webrtc::PcPool,
) {
    tracing::info!("[SDP] guest SDP exchange (peer_token={})", &peer_token[..peer_token.len().min(8)]);

    // Build a fresh PC with TURN for guest. Pool PCs may have stale ICE state.
    let stack = match webrtc::build_session_pc().await {
        Ok(s) => s,
        Err(e) => {
            tracing::error!("[SDP] guest PC build failed: {e}");
            let _ = client.command_result(&cmd.id, &cmd.lease_token,
                &serde_json::json!({"error":"pc_build_failed","message":e})).await;
            return;
        }
    };

    // Add host's video + audio tracks to the guest PC
    use ::webrtc::track::track_local::TrackLocal;
    let video_track = session.video_track.lock().unwrap().clone();
    let audio_track = session.audio_track.lock().unwrap().clone();
    let _ = stack.pc.add_track(video_track as Arc<dyn TrackLocal + Send + Sync>).await;
    let _ = stack.pc.add_track(audio_track as Arc<dyn TrackLocal + Send + Sync>).await;

    // SDP exchange on guest PC
    let answer = match webrtc::exchange_sdp_on_pc(&stack.pc, sdp).await {
        Ok(a) => a,
        Err(e) => {
            tracing::error!("[SDP] guest exchange failed: {e}");
            let _ = client.command_result(&cmd.id, &cmd.lease_token,
                &serde_json::json!({"error":"sdp_handshake_failed","message":e})).await;
            return;
        }
    };

    tracing::info!("[SDP] guest exchange OK ({} chars)", answer.len());

    // Seat = existing guests + local_players (host takes seats 0..local_players-1)
    let local_players = session.local_players.load(std::sync::atomic::Ordering::Relaxed);
    let seat = {
        let guests = session.guests.lock().await;
        guests.len() as u32 + local_players
    };

    // Store guest peer
    let guest = Arc::new(crate::session::GuestPeer {
        pc: stack.pc,
        seat,
        peer_token: peer_token.to_string(),
    });
    session.guests.lock().await.push(Arc::clone(&guest));

    // Wire DC handler for guest input
    wire_dc_handler_for_guest(session, peer_token, seat).await;

    // Send SDP answer back via notify_sdp
    let worker_url = worker_url(&session.game_id);
    if let Err(e) = client.notify_sdp(&cmd.id, &cmd.lease_token, &worker_url, &session.game_id, &answer, None).await {
        tracing::error!("[SDP] guest notify_sdp failed: {e:#}");
    } else {
        tracing::info!("[SDP] guest answer sent ({} chars, seat={})", answer.len(), seat);
    }
}

/// Wire a DataChannel handler for a guest peer.
/// Guest input routes to the assigned seat (not port 0).
/// Guests cannot save/load/list — only the host can.
async fn wire_dc_handler_for_guest(
    session: &Arc<GameSession>,
    peer_token: &str,
    seat: u32,
) {
    let session = Arc::clone(session);
    let pc = {
        let guests = session.guests.lock().await;
        guests.iter()
            .find(|g| g.peer_token == peer_token)
            .map(|g| g.pc.clone())
    };

    let Some(pc) = pc else {
        tracing::warn!("[DC] guest PC not found for peer_token={}", &peer_token[..8]);
        return;
    };

    let peer_token = peer_token.to_string();
    let pt_for_close = peer_token.clone();
    let session_for_close = Arc::clone(&session);
    let pc_for_ice = Arc::clone(&pc);
    let session_for_ice = Arc::clone(&session);
    let pt_for_ice = peer_token.clone();

    pc.on_data_channel(Box::new(move |dc: Arc<_>| {
        let session = Arc::clone(&session);
        let pt = peer_token.clone();
        Box::pin(async move {
            tracing::info!("[DC] guest data channel received: {} (seat={})", dc.label(), seat);

            let dc_for_open = Arc::clone(&dc);
            let dc_for_msg = Arc::clone(&dc);
            let session_for_msg = Arc::clone(&session);

            dc_for_open.on_open(Box::new(move || {
                tracing::info!("[DC] guest channel opened (seat={})", seat);
                Box::pin(async {})
            }));

            // Cleanup on DC close
            let session_cleanup = Arc::clone(&session);
            let pt_cleanup = pt.clone();
            dc_for_open.on_close(Box::new(move || {
                let session = Arc::clone(&session_cleanup);
                let pt = pt_cleanup.clone();
                Box::pin(async move {
                    tracing::info!("[DC] guest disconnected (peer_token={})", &pt[..8]);
                    let mut guests = session.guests.lock().await;
                    guests.retain(|g| g.peer_token != pt);
                })
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

                    // Guest auth: peer_token handshake
                    if let Ok(val) = serde_json::from_slice::<serde_json::Value>(&data) {
                        let cmd_str = val.get("cmd").and_then(|v| v.as_str()).unwrap_or("");
                        if cmd_str == "auth" {
                            tracing::info!("[DC] guest auth received (seat={}), sending ack", seat);
                            let ack = serde_json::json!({"cmd":"auth_ok","seat":seat});
                            let _ = dc.send_text(ack.to_string()).await;
                            return;
                        }
                        // Guests cannot save/load — silently ignore
                        if cmd_str == "save_state" || cmd_str == "load_state" || cmd_str == "list_saves" {
                            return;
                        }
                    }

                    // Binary input: [seat_byte, state_lo, state_hi]
                    if data.len() >= 3 {
                        let state = data[1] as u16 | ((data[2] as u16) << 8);
                        let guard = session.core_cmd_tx.lock().await;
                        if let Some(ref tx) = *guard {
                            let _ = tx.try_send(crate::core_bridge::CoreCommand::SetInput {
                                port: seat,
                                state,
                            });
                        }
                    }
                })
            }));
        })
    }));

    // ICE disconnect watcher — if guest PC fails, remove it
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(std::time::Duration::from_secs(3)).await;
            let state = pc_for_ice.connection_state().to_string();
            if state == "failed" || state == "disconnected" {
                let mut guests = session_for_ice.guests.lock().await;
                guests.retain(|g| g.peer_token != pt_for_ice);
                if guests.is_empty() && !session_for_ice.host_connected.load(std::sync::atomic::Ordering::Relaxed) {
                    tracing::info!("[ICE] last guest left, host gone — cancelling session");
                    session_for_ice.cancel.cancel();
                }
                break;
            }
        }
    });
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

// ── DC handler wiring ────────────────────────────────────────────────

/// Wire the browser's non-negotiated DataChannel to core input commands.
///
/// The browser creates a DataChannel labeled "diagnostics" (non-negotiated).
/// We receive it via `pc.on_data_channel()` and parse:
/// - JSON: `{"cmd":"auth"}` → responds with `{"cmd":"auth_ok"}`
/// - JSON save commands: save_state, load_state, list_saves, load_state_at
/// - Binary 3 bytes: `[seat, state_lo, state_hi]` → `SetInput { port, state }`
///
/// Called once on session creation and again on SDP retry when the PC is swapped.
fn wire_dc_handler(session: &Arc<GameSession>) {
    let session = Arc::clone(session);
    let pc = session.pc.lock().unwrap().clone();

    // ── ICE watcher for host PC ────────────────────────────────────
    let pc_for_ice = Arc::clone(&pc);
    let session_for_ice = Arc::clone(&session);
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(std::time::Duration::from_secs(3)).await;
            let state = pc_for_ice.connection_state().to_string();
            if state == "failed" || state == "disconnected" {
                tracing::warn!("[ICE] host PC {} — notifying browser", state);
                session_for_ice.host_connected.store(false, std::sync::atomic::Ordering::Relaxed);
                // Send error over DC so the browser triggers reconnection.
                // Closing the DC alone doesn't change connectionState reliably.
                if let Some(ref dc) = *session_for_ice.dc.lock().await {
                    let msg = serde_json::json!({"cmd":"error","reason":"ice failed"});
                    let _ = dc.send_text(msg.to_string()).await;
                }
                let has_guests = !session_for_ice.guests.lock().await.is_empty();
                if !has_guests {
                    tracing::info!("[ICE] host PC dead, no guests — cancelling session");
                    session_for_ice.cancel.cancel();
                } else {
                    tracing::info!("[ICE] host PC dead, {} guests present — keeping session alive",
                        session_for_ice.guests.lock().await.len());
                }
                break;
            }
        }
    });

    pc.on_data_channel(Box::new(move |dc: Arc<_>| {
        let session = Arc::clone(&session);
        Box::pin(async move {
            tracing::info!("[DC] browser data channel received: {}", dc.label());

            let dc_for_open = Arc::clone(&dc);
            let dc_for_msg = Arc::clone(&dc);
            let session_for_msg = Arc::clone(&session);

            dc_for_open.on_open(Box::new(move || {
                tracing::info!("[DC] browser channel opened");
                Box::pin(async {})
            }));

            // ── Host DC close — only cancel if no guests ────────────
            let session_close = Arc::clone(&session);
            dc_for_open.on_close(Box::new(move || {
                let session = Arc::clone(&session_close);
                Box::pin(async move {
                    tracing::warn!("[DC] host DC closed — checking guests");
                    session.host_connected.store(false, std::sync::atomic::Ordering::Relaxed);
                    let has_guests = !session.guests.lock().await.is_empty();
                    if !has_guests {
                        tracing::info!("[DC] host gone, no guests — cancelling session");
                        session.cancel.cancel();
                    } else {
                        tracing::info!("[DC] host gone, {} guests present — session stays alive",
                            session.guests.lock().await.len());
                    }
                })
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

                    if let Ok(val) = serde_json::from_slice::<serde_json::Value>(&data) {
                        let cmd = val.get("cmd").and_then(|v| v.as_str()).unwrap_or("");

                        match cmd {
                            "auth" => {
                                tracing::info!("[DC] auth received, sending ack");
                                // Extract local_players for multi-gamepad seat offset
                                if let Some(lp) = val.get("local_players").and_then(|v| v.as_u64()) {
                                    session.local_players.store(lp as u32, std::sync::atomic::Ordering::Relaxed);
                                    tracing::info!("[DC] host reported local_players={}", lp);
                                }
                                let ack = serde_json::json!({"cmd": "auth_ok"});
                                let _ = dc.send_text(ack.to_string()).await;
                                // Store DC for crash notification, mark host connected
                                *session.dc.lock().await = Some(Arc::clone(&dc));
                                session.host_connected.store(true, std::sync::atomic::Ordering::Relaxed);
                                return;
                            }
                            "save_state" => {
                                handle_save_state(&session, &dc).await;
                                return;
                            }
                            "load_state" => {
                                let index = val.get("index").and_then(|v| v.as_u64()).map(|i| i as u32);
                                handle_load_state(&session, &dc, index).await;
                                return;
                            }
                            "list_saves" => {
                                handle_list_saves(&session, &dc).await;
                                return;
                            }
                            _ => {}
                        }
                    }

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

// ── Save stack command handlers ──────────────────────────────────────

async fn handle_save_state(session: &Arc<GameSession>, dc: &Arc<::webrtc::data_channel::RTCDataChannel>) {
    let rh = {
        let guard = session.rom_hash.lock().await;
        guard.clone()
    };
    let Some(rom_hash) = rh else {
        tracing::warn!("[SAVE] no rom_hash — can't save");
        let _ = dc.send_text(r#"{"cmd":"save_result","ok":false,"error":"no rom hash"}"#).await;
        return;
    };

    // Dispatch save to core
    {
        let guard = session.core_cmd_tx.lock().await;
        if let Some(ref tx) = *guard {
            let _ = tx.send(core_bridge::CoreCommand::SaveState);
        } else {
            let _ = dc.send_text(r#"{"cmd":"save_result","ok":false,"error":"core not loaded"}"#).await;
            return;
        }
    }

    // Wait for response from bridge thread
    let result = {
        let guard = session.core_response_rx.lock().await;
        if let Some(ref rx) = *guard {
            rx.recv_timeout(std::time::Duration::from_secs(5)).ok()
        } else {
            None
        }
    };

    match result {
        Some(core_bridge::CoreResponse::SaveStateResult { data, ok: true }) => {
            let hash = rom_hash.clone();
            let data_len = data.len();
            match tokio::task::spawn_blocking(move || saves::save_stack_push(&hash, &data)).await {
                Ok(Ok(index)) => {
                    tracing::info!("[SAVE] saved entry {} ({} bytes)", index, data_len);
                    let resp = serde_json::json!({"cmd":"save_result","ok":true,"index":index,"size":data_len});
                    let _ = dc.send_text(resp.to_string()).await;
                }
                Ok(Err(e)) => {
                    tracing::error!("[SAVE] disk write failed: {e}");
                    let _ = dc.send_text(r#"{"cmd":"save_result","ok":false,"error":"disk write failed"}"#).await;
                }
                Err(e) => {
                    tracing::error!("[SAVE] spawn_blocking failed: {e}");
                    let _ = dc.send_text(r#"{"cmd":"save_result","ok":false,"error":"internal error"}"#).await;
                }
            }
        }
        Some(core_bridge::CoreResponse::SaveStateResult { ok: false, .. }) => {
            tracing::warn!("[SAVE] core returned empty state");
            let _ = dc.send_text(r#"{"cmd":"save_result","ok":false,"error":"empty state"}"#).await;
        }
        _ => {
            tracing::warn!("[SAVE] no response from core");
            let _ = dc.send_text(r#"{"cmd":"save_result","ok":false,"error":"core timeout"}"#).await;
        }
    }
}

async fn handle_load_state(
    session: &Arc<GameSession>,
    dc: &Arc<::webrtc::data_channel::RTCDataChannel>,
    index: Option<u32>,
) {
    let rh = {
        let guard = session.rom_hash.lock().await;
        guard.clone()
    };
    let Some(rom_hash) = rh else {
        let _ = dc.send_text(r#"{"cmd":"load_result","ok":false,"error":"no rom hash"}"#).await;
        return;
    };

    // Read state data from disk
    let hash = rom_hash.clone();
    let data = match tokio::task::spawn_blocking(move || -> Result<Vec<u8>, String> {
        match index {
            Some(i) => saves::save_stack_load(&hash, i).map_err(|e| e.to_string()),
            None => saves::save_stack_load_latest(&hash)
                .map_err(|e| e.to_string())
                .and_then(|opt| opt.map(|(_, d)| d).ok_or_else(|| "no saves".to_string())),
        }
    }).await {
        Ok(Ok(d)) => d,
        Ok(Err(e)) => {
            tracing::warn!("[SAVE] load from disk failed: {e}");
            let _ = dc.send_text(format!(r#"{{"cmd":"load_result","ok":false,"error":"{}"}}"#, e)).await;
            return;
        }
        Err(e) => {
            tracing::error!("[SAVE] spawn_blocking failed: {e}");
            let _ = dc.send_text(r#"{"cmd":"load_result","ok":false,"error":"internal error"}"#).await;
            return;
        }
    };

    if data.is_empty() {
        let _ = dc.send_text(r#"{"cmd":"load_result","ok":false,"error":"empty state data"}"#).await;
        return;
    }

    // Dispatch load to core (with state data)
    {
        let guard = session.core_cmd_tx.lock().await;
        if let Some(ref tx) = *guard {
            let len = data.len();
            let _ = tx.send(core_bridge::CoreCommand::LoadState { data });
            tracing::info!("[SAVE] loading state ({} bytes)", len);
        } else {
            let _ = dc.send_text(r#"{"cmd":"load_result","ok":false,"error":"core not loaded"}"#).await;
            return;
        }
    }

    // Wait for response
    let result = {
        let guard = session.core_response_rx.lock().await;
        if let Some(ref rx) = *guard {
            rx.recv_timeout(std::time::Duration::from_secs(5)).ok()
        } else {
            None
        }
    };

    match result {
        Some(core_bridge::CoreResponse::LoadStateResult { ok: true }) => {
            let _ = dc.send_text(r#"{"cmd":"load_result","ok":true}"#).await;
        }
        _ => {
            let _ = dc.send_text(r#"{"cmd":"load_result","ok":false,"error":"core rejected state"}"#).await;
        }
    }
}

async fn handle_list_saves(session: &Arc<GameSession>, dc: &Arc<::webrtc::data_channel::RTCDataChannel>) {
    let rh = {
        let guard = session.rom_hash.lock().await;
        guard.clone()
    };
    let Some(rom_hash) = rh else {
        let _ = dc.send_text(r#"{"cmd":"list_saves_result","entries":[]}"#).await;
        return;
    };

    let hash = rom_hash.clone();
    match tokio::task::spawn_blocking(move || saves::save_stack_list(&hash)).await {
        Ok(Ok(stack)) => {
            let resp = serde_json::json!({
                "cmd": "list_saves_result",
                "entries": stack.entries,
                "next_index": stack.next_index,
            });
            let _ = dc.send_text(resp.to_string()).await;
        }
        Ok(Err(_)) | Err(_) => {
            let _ = dc.send_text(r#"{"cmd":"list_saves_result","entries":[]}"#).await;
        }
    }
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
