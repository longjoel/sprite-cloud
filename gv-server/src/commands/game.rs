//! Game lifecycle and WebRTC SDP handlers.

use super::*;

// ── Command handlers ────────────────────────────────────────────────

pub(super) async fn handle_start_game(
    cmd: &gv_web::Command,
    client: &gv_web::GvWebClient,
    sessions: &mut HashMap<String, Arc<GameSession>>,
    rom_roots: &[String],
    pool: &webrtc::PcPool,
) {
    let game_id = cmd.payload.get("game_id").and_then(|v| v.as_str()).unwrap_or("unknown");
    let session_id = cmd.payload.get("session_id").and_then(|v| v.as_str()).unwrap_or("");
    let _host_token = cmd.payload.get("host_token").and_then(|v| v.as_str());
    let platform = cmd.payload.get("platform").and_then(|v| v.as_str());
    let rom_path = cmd.payload.get("rom_path").and_then(|v| v.as_str());
    let sdp_offer = cmd.payload.get("sdp").and_then(|v| v.as_str());
    let is_lan = cmd.payload.get("lan").and_then(|v| v.as_bool()).unwrap_or(false);

    tracing::info!("[POLL] start_game game={game_id} session={session_id} sdp={} lan={is_lan}", sdp_offer.is_some());
    let t_total = std::time::Instant::now();

    // Kill existing session for this game_id
    if let Some(old) = sessions.remove(game_id) {
        tracing::info!("[SESSION] killing previous session for {game_id}");
        old.cancel.cancel();
    }

    // Resolve ROM path
    let t0 = std::time::Instant::now();
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
    let t1 = std::time::Instant::now();
    let core_path = match platform
        .and_then(crate::platform::core_for_platform)
    {
        Some(core_file) => {
            match core_bridge::ensure_core(&core_file, client.http_client()).await {
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

    // Acquire WebRTC stack — use pool for remote (TURN), build fresh for LAN (direct)
    let stack = if is_lan {
        match webrtc::build_session_pc_lan().await {
            Ok(s) => {
                tracing::info!("[SESSION] LAN direct — built fresh PC with All policy + STUN only");
                s
            }
            Err(e) => {
                tracing::error!("[SESSION] LAN PC build failed: {e}");
                let _ = client.command_result(
                    &cmd.id, &cmd.lease_token,
                    &serde_json::json!({"error": "webrtc_build_failed", "message": e}),
                ).await;
                return;
            }
        }
    } else {
        match pool.acquire().await {
            Ok(s) => s,
            Err(e) => {
                tracing::error!("[SESSION] pool.acquire failed: {e}");
                let _ = client.command_result(
                    &cmd.id, &cmd.lease_token,
                    &serde_json::json!({"error": "webrtc_build_failed", "message": e}),
                ).await;
                return;
            }
        }
    };
    let t2 = std::time::Instant::now();

    // Compute ROM hash for save persistence
    let rom_hash = content_path.as_deref()
        .and_then(|p| saves::hash_rom(std::path::Path::new(p)));

    // Create session
    let session = Arc::new(GameSession {
        game_id: game_id.to_string(),
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
        core_cmd_tx: tokio::sync::Mutex::new(None),
        core_frame_rx: tokio::sync::Mutex::new(None),
        core_response_rx: tokio::sync::Mutex::new(None),
        video_enc: tokio::sync::Mutex::new(None),
        audio_enc: tokio::sync::Mutex::new(None),
        rom_hash: tokio::sync::Mutex::new(rom_hash),
        core_width: tokio::sync::Mutex::new(0),
        core_height: tokio::sync::Mutex::new(0),
        core_fps: tokio::sync::Mutex::new(0.0),
        core_sample_rate: tokio::sync::Mutex::new(48000.0),
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
    dc_handler::wire_dc_handler(&session);

    // Spawn streaming loop
    let stream_session = Arc::clone(&session);
    let _stream_cancel = session.cancel.clone();
    tokio::spawn(async move {
        streaming::run_stream(stream_session).await;
    });

    // Store session (clone before moving into HashMap)
    sessions.insert(game_id.to_string(), Arc::clone(&session));
    let t3 = std::time::Instant::now();

    // Notify gv-web — include SDP answer if offer was provided
    if let Some(offer) = sdp_offer {
        // SDP exchange with retry: first attempt on session PC,
        // then acquire fresh PC from pool and retry if needed
        let max_attempts = 2u32;
        let mut sdp_result = Err("no attempts".to_string());

        for attempt in 1..=max_attempts {
            let pc = session.pc.lock().expect("mutex poisoned").clone();
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
                        if is_lan {
                            // For LAN connections, build fresh PC instead of pool acquire
                            match webrtc::build_session_pc_lan().await {
                                Ok(fresh) => {
                                    tracing::info!("[SESSION] SDP retry (LAN): built fresh PC");
                                    *session.video_track.lock().expect("mutex poisoned") = fresh.video_track;
                                    *session.audio_track.lock().expect("mutex poisoned") = fresh.audio_track;
                                    *session.pc.lock().expect("mutex poisoned") = fresh.pc;
                                    dc_handler::wire_dc_handler(&session);
                                    tokio::time::sleep(Duration::from_millis(500)).await;
                                }
                                Err(e2) => {
                                    tracing::error!("[SESSION] SDP retry (LAN): build failed: {e2}");
                                    break;
                                }
                            }
                        } else {
                            // Acquire fresh PC from pool and swap into session
                            match pool.acquire().await {
                                Ok(fresh) => {
                                    tracing::info!("[SESSION] SDP retry: swapped in fresh PC from pool");
                                    // Swap tracks too — the streaming loop references them
                                    *session.video_track.lock().expect("mutex poisoned") = fresh.video_track;
                                    *session.audio_track.lock().expect("mutex poisoned") = fresh.audio_track;
                                    *session.pc.lock().expect("mutex poisoned") = fresh.pc;
                                    // Re-wire DC handler on the new PC
                                    dc_handler::wire_dc_handler(&session);
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

    let total = t_total.elapsed();
    tracing::info!(
        "[TIMING] start_game total={total:.3?} | rom={:.3?} core={:.3?} webrtc={:.3?} load={:.3?} sdp={:.3?}",
        t1.duration_since(t0),
        t2.duration_since(t1),
        t3.duration_since(t2),
        t3.duration_since(t2),
        total.saturating_sub(t3.duration_since(t_total)),
    );
}

pub(super) async fn handle_stop_game(
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

pub(super) async fn handle_sdp_offer(
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
    let is_guest = cmd.payload.as_object().is_some_and(|obj| {
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
        .is_some_and(|obj| obj.contains_key("host_token"));
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
                        *session.video_track.lock().expect("mutex poisoned") = fresh.video_track;
                        *session.audio_track.lock().expect("mutex poisoned") = fresh.audio_track;
                        *session.pc.lock().expect("mutex poisoned") = fresh.pc;
                        dc_handler::wire_dc_handler(session);

                        let pc = session.pc.lock().expect("mutex poisoned").clone();
                        match webrtc::exchange_sdp_on_pc(&pc, sdp).await {
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
                let pc = session.pc.lock().expect("mutex poisoned").clone();
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
                                    *session.video_track.lock().expect("mutex poisoned") = fresh.video_track;
                                    *session.audio_track.lock().expect("mutex poisoned") = fresh.audio_track;
                                    *session.pc.lock().expect("mutex poisoned") = fresh.pc;
                                    dc_handler::wire_dc_handler(session);
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
pub(super) async fn handle_guest_sdp(
    session: &Arc<GameSession>,
    sdp: &str,
    peer_token: &str,
    cmd: &gv_web::Command,
    client: &gv_web::GvWebClient,
    _pool: &webrtc::PcPool,
) {
    tracing::info!("[SDP] guest SDP exchange (peer_token={})", &peer_token[..peer_token.len().min(8)]);

    // Build a fresh PC — with TURN for remote, without TURN for LAN guests
    let is_lan = cmd.payload.get("lan").and_then(|v| v.as_bool()).unwrap_or(false);
    let stack = if is_lan {
        match webrtc::build_session_pc_lan().await {
            Ok(s) => {
                tracing::info!("[SDP] guest LAN — built fresh PC with All policy + STUN only");
                s
            }
            Err(e) => {
                tracing::error!("[SDP] guest LAN PC build failed: {e}");
                let _ = client.command_result(&cmd.id, &cmd.lease_token,
                    &serde_json::json!({"error":"pc_build_failed","message":e})).await;
                return;
            }
        }
    } else {
        match webrtc::build_session_pc().await {
            Ok(s) => s,
            Err(e) => {
                tracing::error!("[SDP] guest PC build failed: {e}");
                let _ = client.command_result(&cmd.id, &cmd.lease_token,
                    &serde_json::json!({"error":"pc_build_failed","message":e})).await;
                return;
            }
        }
    };

    // Add host's video + audio tracks to the guest PC
    use ::webrtc::track::track_local::TrackLocal;
    let video_track = session.video_track.lock().expect("mutex poisoned").clone();
    let audio_track = session.audio_track.lock().expect("mutex poisoned").clone();
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
pub(super) async fn wire_dc_handler_for_guest(
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
    let _pt_for_close = peer_token.clone();
    let _session_for_close = Arc::clone(&session);
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

pub(super) async fn handle_browse_files(
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

pub(super) async fn handle_scan_paths(
    cmd: &gv_web::Command,
    client: &gv_web::GvWebClient,
    rom_roots: &[String],
    scan_lock: &Arc<tokio::sync::Mutex<()>>,
    dat_index: &Arc<tokio::sync::RwLock<Option<dat::DatIndex>>>,
    server_id: &str,
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
                        .join("sprite-cloud")
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

    // Auto-import scanned files into the library
    let import_files: Vec<serde_json::Value> = matches.iter().map(|m| {
        let file = &m["file"];
        let match_name = m["match"]["name"].as_str();
        let name = match_name.unwrap_or(file["file_name"].as_str().unwrap_or("unknown"));
        serde_json::json!({
            "name": name,
            "platform": file["platform"].as_str().unwrap_or("Unknown"),
            "rom_path": file["relative_path"].as_str().unwrap_or(""),
            "file_name": file["file_name"].as_str().unwrap_or(""),
            "file_size": file["file_size"].as_u64().unwrap_or(0),
            "file_hash": file["sha256"].as_str().unwrap_or(""),
        })
    }).collect();

    match client.import_library(server_id, &import_files).await {
        Ok(()) => {
            let _ = client.command_result(
                &cmd.id, &cmd.lease_token,
                &serde_json::json!({"matches": matches, "imported": import_files.len()}),
            ).await;
        }
        Err(e) => {
            tracing::warn!("[SCAN] auto-import failed: {e:#}");
            let _ = client.command_result(
                &cmd.id, &cmd.lease_token,
                &serde_json::json!({"matches": matches, "import_error": e.to_string()}),
            ).await;
        }
    }
}

