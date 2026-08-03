//! Game lifecycle and WebRTC SDP handlers.

use super::*;

fn signal_log(flow: &str, stage: &str, details: &str) {
    if details.is_empty() {
        tracing::info!("[SIGNAL] flow={} stage={}", flow, stage);
    } else {
        tracing::info!("[SIGNAL] flow={} stage={} {}", flow, stage, details);
    }
}

async fn record_server_local_play(
    preferences: &crate::player_server::SharedLibraryState,
    game_id: &str,
    launch_ready: bool,
    server_local: bool,
) {
    if !launch_ready || !server_local {
        return;
    }
    match time::OffsetDateTime::now_utc().format(&time::format_description::well_known::Rfc3339) {
        Ok(played_at) => {
            if let Err(error) = preferences.lock().await.record_played(game_id, &played_at) {
                tracing::warn!("[library] failed to record paired recent play: {error}");
            }
        }
        Err(error) => tracing::warn!("[library] failed to format recent timestamp: {error}"),
    }
}

// ── Command handlers ────────────────────────────────────────────────

pub(super) async fn handle_start_game(
    cmd: &sc_web::Command,
    client: &sc_web::ScWebClient,
    sessions: &mut HashMap<String, Arc<GameSession>>,
    rom_roots: &[String],
    local_games: &Arc<tokio::sync::RwLock<Vec<crate::player_server::LocalGame>>>,
    pool: &webrtc::PcPool,
    library_preferences: &crate::player_server::SharedLibraryState,
) {
    let game_id = cmd
        .payload
        .get("game_id")
        .and_then(|v| v.as_str())
        .unwrap_or("unknown");
    let session_id = cmd
        .payload
        .get("session_id")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let _host_token = cmd.payload.get("host_token").and_then(|v| v.as_str());
    let legacy_platform = cmd
        .payload
        .get("platform")
        .and_then(|v| v.as_str())
        .map(str::to_string);
    let legacy_rom_path = cmd.payload.get("rom_path").and_then(|v| v.as_str());
    let sdp_offer = cmd.payload.get("sdp").and_then(|v| v.as_str());
    let is_lan = cmd
        .payload
        .get("lan")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    signal_log(
        "host_start",
        "command_polled",
        &format!(
            "command_id={} game_id={} has_sdp={} is_lan={} session_id={}",
            cmd.id,
            game_id,
            sdp_offer.is_some(),
            is_lan,
            session_id
        ),
    );
    let t_total = std::time::Instant::now();

    // Kill existing session for this game_id
    if let Some(old) = sessions.remove(game_id) {
        signal_log(
            "host_start",
            "previous_session_cancelled",
            &format!("game_id={}", game_id),
        );
        old.cancel.cancel();
    }

    // Resolve opaque local IDs inside sc-server. Legacy path/platform fields are
    // retained only for compatibility while the hosted frontend migrates.
    let t0 = std::time::Instant::now();
    let local_resolution = if game_id.starts_with("local_") {
        let games = local_games.read().await;
        match crate::player_server::resolve_local_game(game_id, &games, rom_roots) {
            Ok(resolved) => Some(resolved),
            Err(error) => {
                tracing::warn!("[SESSION] local game resolution failed: {game_id}: {error}");
                let _ = client
                    .command_result(
                        &cmd.id,
                        &cmd.lease_token,
                        &serde_json::json!({"error": "game_not_found", "message": error}),
                    )
                    .await;
                return;
            }
        }
    } else {
        None
    };

    let server_local = local_resolution.is_some();
    let (content_path, platform) = if let Some((path, platform)) = local_resolution {
        (Some(path.to_string_lossy().to_string()), Some(platform))
    } else {
        let content_path = legacy_rom_path.and_then(|relative| {
            let relative_path = std::path::Path::new(relative);
            for root in rom_roots {
                let candidate = std::path::Path::new(root).join(relative_path);
                if !candidate.exists() {
                    continue;
                }
                match crate::scan::resolve_within_roots(&candidate, rom_roots) {
                    Ok(resolved) => return Some(resolved.to_string_lossy().to_string()),
                    Err(error) => tracing::warn!("[SESSION] rejected rom_path {relative}: {error}"),
                }
            }
            tracing::warn!("[SESSION] rom_path not found: {relative}");
            None
        });
        (content_path, legacy_platform)
    };

    // Resolve (and download if needed) core from platform
    let t1 = std::time::Instant::now();
    let core_path = match platform
        .as_deref()
        .and_then(crate::platform::core_for_platform)
    {
        Some(core_file) => match core_bridge::ensure_core(&core_file, client.http_client()).await {
            Ok(path) => {
                tracing::info!("[SESSION] core resolved: {}", path.display());
                Some(path)
            }
            Err(e) => {
                tracing::warn!(
                    "[SESSION] core download failed for {core_file}: {e} — will use test pattern"
                );
                None
            }
        },
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
                let _ = client
                    .command_result(
                        &cmd.id,
                        &cmd.lease_token,
                        &serde_json::json!({"error": "webrtc_build_failed", "message": e}),
                    )
                    .await;
                return;
            }
        }
    } else {
        match pool.acquire().await {
            Ok(s) => s,
            Err(e) => {
                tracing::error!("[SESSION] pool.acquire failed: {e}");
                let _ = client
                    .command_result(
                        &cmd.id,
                        &cmd.lease_token,
                        &serde_json::json!({"error": "webrtc_build_failed", "message": e}),
                    )
                    .await;
                return;
            }
        }
    };
    let t2 = std::time::Instant::now();

    // Compute ROM hash for save persistence
    let rom_hash = content_path
        .as_deref()
        .and_then(|p| saves::hash_rom(std::path::Path::new(p)));

    // Create session
    let session = Arc::new(GameSession {
        game_id: game_id.to_string(),
        cloud_session_id: cmd
            .payload
            .get("session_id")
            .and_then(|value| value.as_str())
            .map(str::to_owned),
        cancel: tokio_util::sync::CancellationToken::new(),
        core_stopped: tokio_util::sync::CancellationToken::new(),
        pc: std::sync::Mutex::new(stack.pc),
        video_track: std::sync::Mutex::new(stack.video_track),
        audio_track: std::sync::Mutex::new(stack.audio_track),
        dc: tokio::sync::Mutex::new(None),
        guests: tokio::sync::Mutex::new(Vec::new()),
        host_connected: std::sync::atomic::AtomicBool::new(false),
        local_players: std::sync::atomic::AtomicU32::new(1),
        account_id: tokio::sync::Mutex::new(None),
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
    if let Err(error) = core_bridge::load_core_into_session(
        &session,
        core_path.as_deref(),
        content_path.as_deref(),
        platform.as_deref(),
    )
    .await
    {
        session.cancel.cancel();
        tracing::error!("[SESSION] core startup failed: {error}");
        let _ = client
            .command_result(
                &cmd.id,
                &cmd.lease_token,
                &serde_json::json!({"error": "core_start_failed", "message": error}),
            )
            .await;
        return;
    }

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

    // Notify sc-web — include SDP answer if offer was provided
    let mut launch_ready = false;
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
                        elapsed,
                        answer.len()
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
                                    *session.video_track.lock().expect("mutex poisoned") =
                                        fresh.video_track;
                                    *session.audio_track.lock().expect("mutex poisoned") =
                                        fresh.audio_track;
                                    *session.pc.lock().expect("mutex poisoned") = fresh.pc;
                                    dc_handler::wire_dc_handler(&session);
                                    tokio::time::sleep(Duration::from_millis(500)).await;
                                }
                                Err(e2) => {
                                    tracing::error!(
                                        "[SESSION] SDP retry (LAN): build failed: {e2}"
                                    );
                                    break;
                                }
                            }
                        } else {
                            // Acquire fresh PC from pool and swap into session
                            match pool.acquire().await {
                                Ok(fresh) => {
                                    tracing::info!(
                                        "[SESSION] SDP retry: swapped in fresh PC from pool"
                                    );
                                    // Swap tracks too — the streaming loop references them
                                    *session.video_track.lock().expect("mutex poisoned") =
                                        fresh.video_track;
                                    *session.audio_track.lock().expect("mutex poisoned") =
                                        fresh.audio_track;
                                    *session.pc.lock().expect("mutex poisoned") = fresh.pc;
                                    // Re-wire DC handler on the new PC
                                    dc_handler::wire_dc_handler(&session);
                                    tokio::time::sleep(Duration::from_millis(500)).await;
                                }
                                Err(e2) => {
                                    tracing::error!(
                                        "[SESSION] SDP retry: pool.acquire failed: {e2}"
                                    );
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
                    .notify_sdp(
                        &cmd.id,
                        &cmd.lease_token,
                        &worker_url,
                        game_id,
                        &answer_sdp,
                        Some(session_id),
                    )
                    .await
                {
                    tracing::error!("[NOTIFY] notify_sdp failed: {e:#}");
                } else {
                    launch_ready = true;
                    signal_log(
                        "host_start",
                        "notify_sdp_sent",
                        &format!(
                            "command_id={} game_id={} sdp_answer_length={}",
                            cmd.id,
                            game_id,
                            answer_sdp.len()
                        ),
                    );
                    tracing::info!("[SESSION] game ready with SDP: {game_id}");
                }
            }
            Err(e) => {
                tracing::error!("[SESSION] SDP exchange failed after {max_attempts} attempts: {e}");
                let _ = client
                    .command_result(
                        &cmd.id,
                        &cmd.lease_token,
                        &serde_json::json!({"error": "sdp_handshake_failed", "message": e}),
                    )
                    .await;
                return;
            }
        }
    } else {
        if let Err(e) = client
            .notify(
                &cmd.id,
                &cmd.lease_token,
                &worker_url,
                game_id,
                Some(session_id),
            )
            .await
        {
            tracing::error!("[NOTIFY] failed: {e:#}");
        } else {
            launch_ready = true;
            signal_log(
                "host_start",
                "notify_ready_sent",
                &format!(
                    "command_id={} game_id={} session_id={}",
                    cmd.id, game_id, session_id
                ),
            );
            tracing::info!("[SESSION] game ready: {game_id}");
        }
    }

    record_server_local_play(library_preferences, game_id, launch_ready, server_local).await;

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
    cmd: &sc_web::Command,
    client: &sc_web::ScWebClient,
    sessions: &mut HashMap<String, Arc<GameSession>>,
) {
    let game_id = cmd
        .payload
        .get("game_id")
        .and_then(|v| v.as_str())
        .unwrap_or("unknown");
    tracing::info!("[POLL] stop_game game={game_id}");

    let target_session_id = cmd.payload.get("session_id").and_then(|v| v.as_str());
    let mut stopped = false;
    if let Some(target_session_id) = target_session_id {
        let matches_current = sessions
            .get(game_id)
            .and_then(|session| session.cloud_session_id.as_deref())
            == Some(target_session_id);
        if matches_current && let Some(session) = sessions.remove(game_id) {
            session.cancel.cancel();
            stopped = true;
        } else if sessions.contains_key(game_id) {
            tracing::warn!("[POLL] ignoring stale stop for a superseded game session");
        } else {
            tracing::info!("[POLL] stop_game for already-ended session {game_id}, skipping notify");
        }
    } else {
        tracing::warn!("[POLL] stop_game command missing exact cloud session id");
    }
    if stopped {
        let _ = client
            .notify_stop(&cmd.id, &cmd.lease_token, game_id, target_session_id)
            .await
            .map_err(|e| tracing::warn!("[POLL] notify_stop failed for {}: {:#}", game_id, e));
    }
}

pub(super) async fn handle_sdp_offer(
    cmd: &sc_web::Command,
    client: &sc_web::ScWebClient,
    sessions: &HashMap<String, Arc<GameSession>>,
    pool: &webrtc::PcPool,
) {
    let sdp = cmd
        .payload
        .get("sdp")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let game_id = cmd
        .payload
        .get("game_id")
        .and_then(|v| v.as_str())
        .unwrap_or("unknown");
    let cloud_session_id = cmd.payload.get("session_id").and_then(|v| v.as_str());
    let Some(cloud_session_id) = cloud_session_id else {
        tracing::warn!("[SDP] command missing exact cloud session id — ignoring");
        let _ = client
            .command_result(
                &cmd.id,
                &cmd.lease_token,
                &serde_json::json!({"error": "session_id_required"}),
            )
            .await;
        return;
    };
    let peer_token = cmd
        .payload
        .get("peer_token")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    if sdp.is_empty() {
        tracing::warn!("[SDP] empty offer — ignoring");
        return;
    }

    // ── Guest / Host dispatch ─────────────────────────────────────────
    // Guest SDP offers create a new PC — never touch the host's PC.
    let is_guest = cmd
        .payload
        .as_object()
        .is_some_and(|obj| obj.contains_key("peer_token") || obj.contains_key("room_token"));
    let has_host_token = cmd
        .payload
        .as_object()
        .is_some_and(|obj| obj.contains_key("host_token"));

    let flow = if is_guest {
        "guest_offer"
    } else {
        "host_reconnect"
    };
    signal_log(
        flow,
        "command_polled",
        &format!(
            "command_id={} game_id={} has_host_token={} has_peer_token={} sdp_length={}",
            cmd.id,
            game_id,
            has_host_token,
            peer_token.is_some(),
            sdp.len()
        ),
    );

    // Wait for session to appear (core loading may take a moment).
    // But if this is a host reconnection (host_token in SDP payload)
    // and the session is gone, fail fast — don't make the browser wait 30s.
    let started = std::time::Instant::now();
    let max_wait = Duration::from_secs(30);
    loop {
        if let Some(session) = sessions.get(game_id) {
            if session.cloud_session_id.as_deref() != Some(cloud_session_id) {
                tracing::warn!(
                    "[SDP] exact cloud session does not match current runtime — ignoring"
                );
                let _ = client
                    .command_result(
                        &cmd.id,
                        &cmd.lease_token,
                        &serde_json::json!({"error": "session_mismatch"}),
                    )
                    .await;
                return;
            }
            // ── Guest path: new PC from pool, never touch host PC. ────
            if is_guest {
                handle_guest_sdp(
                    session,
                    sdp,
                    &peer_token.unwrap_or_default(),
                    cmd,
                    client,
                    pool,
                )
                .await;
                return;
            }

            // ── Host reconnection fast-path ─────────────────────────
            // If host_connected is false, the old PC is dead (DC close / ICE fail).
            // Skip it entirely — acquire fresh PC and do a clean exchange.
            let reconnecting = !session
                .host_connected
                .load(std::sync::atomic::Ordering::Relaxed);
            if reconnecting {
                signal_log(flow, "fresh_pc_requested", &format!("game_id={}", game_id));
                tracing::info!("[SDP] host reconnecting — swapping in fresh PC");
                match pool.acquire().await {
                    Ok(fresh) => {
                        let rebind_video = fresh.video_track.clone();
                        let rebind_audio = fresh.audio_track.clone();
                        *session.video_track.lock().expect("mutex poisoned") = fresh.video_track;
                        *session.audio_track.lock().expect("mutex poisoned") = fresh.audio_track;
                        *session.pc.lock().expect("mutex poisoned") = fresh.pc;
                        rebind_guest_tracks(session, rebind_video, rebind_audio).await;
                        dc_handler::wire_dc_handler(session);

                        let pc = session.pc.lock().expect("mutex poisoned").clone();
                        match webrtc::exchange_sdp_on_pc(&pc, sdp).await {
                            Ok(answer_sdp) => {
                                signal_log(
                                    flow,
                                    "sdp_answer_created",
                                    &format!(
                                        "game_id={} sdp_answer_length={}",
                                        game_id,
                                        answer_sdp.len()
                                    ),
                                );
                                tracing::info!(
                                    "[SDP] reconnection exchange OK ({} chars)",
                                    answer_sdp.len()
                                );
                                let worker_url = worker_url(game_id);
                                let session_id =
                                    cmd.payload.get("session_id").and_then(|v| v.as_str());
                                let _ = client
                                    .notify_sdp(
                                        &cmd.id,
                                        &cmd.lease_token,
                                        &worker_url,
                                        game_id,
                                        &answer_sdp,
                                        session_id,
                                    )
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
                            elapsed,
                            answer.len()
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
                                    let rebind_video = fresh.video_track.clone();
                                    let rebind_audio = fresh.audio_track.clone();
                                    *session.video_track.lock().expect("mutex poisoned") =
                                        fresh.video_track;
                                    *session.audio_track.lock().expect("mutex poisoned") =
                                        fresh.audio_track;
                                    *session.pc.lock().expect("mutex poisoned") = fresh.pc;
                                    rebind_guest_tracks(session, rebind_video, rebind_audio).await;
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
                        .notify_sdp(
                            &cmd.id,
                            &cmd.lease_token,
                            &worker_url,
                            game_id,
                            &answer_sdp,
                            session_id,
                        )
                        .await
                    {
                        tracing::error!("[SDP] notify_sdp failed: {e:#}");
                    } else {
                        signal_log(
                            flow,
                            "notify_sdp_sent",
                            &format!(
                                "command_id={} game_id={} sdp_answer_length={}",
                                cmd.id,
                                game_id,
                                answer_sdp.len()
                            ),
                        );
                        tracing::info!("[SDP] answer sent ({}) chars", answer_sdp.len());
                    }
                }
                Err(e) => {
                    tracing::error!("[SDP] exchange failed after {max_attempts} attempts: {e}");
                    let _ = client
                        .command_result(
                            &cmd.id,
                            &cmd.lease_token,
                            &serde_json::json!({"error": "sdp_handshake_failed", "message": e}),
                        )
                        .await;
                }
            }
            return;
        }

        if started.elapsed() >= max_wait
            || (has_host_token && started.elapsed() >= Duration::from_millis(100))
        {
            let reason = if has_host_token {
                "session gone — server may have restarted"
            } else {
                "session not ready"
            };
            signal_log(
                flow,
                "session_missing",
                &format!("game_id={} reason={}", game_id, reason),
            );
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

/// Guest SDP exchange — builds a clean PC (no pre-added tracks), adds session
/// tracks, does SDP exchange, stores the guest, and wires the DC handler.
///
/// IMPORTANT: never uses the pool — pool PCs come with pre-added tracks, and
/// adding session tracks on top of them produces SDP answers with duplicate m=
/// sections that break WebRTC negotiation with the guest browser.
pub(super) async fn handle_guest_sdp(
    session: &Arc<GameSession>,
    sdp: &str,
    peer_token: &str,
    cmd: &sc_web::Command,
    client: &sc_web::ScWebClient,
    _pool: &webrtc::PcPool,
) {
    let peer_role = cmd
        .payload
        .get("peer_role")
        .and_then(|value| value.as_str())
        .unwrap_or("viewer")
        .to_string();
    let peer_seat = cmd
        .payload
        .get("peer_seat")
        .and_then(|value| value.as_u64())
        .and_then(|value| u32::try_from(value).ok());
    let report_error = |msg: &str| {
        tracing::error!("[SDP] guest error: {msg}");
    };

    signal_log(
        "guest_offer",
        "guest_exchange_started",
        &format!(
            "game_id={} peer_token_present={}",
            session.game_id,
            !peer_token.is_empty()
        ),
    );
    tracing::info!("[SDP] guest SDP exchange (peer capability present)");

    // Build a FRESH PC with NO pre-added tracks.
    // Pool PCs carry their own video/audio tracks — adding session tracks on
    // top creates a 4-track PC whose SDP answer has 4 m= sections against the
    // browser's 2-media-section offer, breaking negotiation.
    let pc = match webrtc::build_pc_for_guest().await {
        Ok(pc) => {
            tracing::info!("[SDP] guest built fresh PC (no pre-added tracks)");
            pc
        }
        Err(e) => {
            tracing::error!("[SDP] guest PC build failed: {e}");
            report_error(&e);
            return;
        }
    };

    // Add ONLY the session's video + audio tracks to the guest PC
    use ::webrtc::track::track_local::TrackLocal;
    let video_track = match session.video_track.lock() {
        Ok(t) => t.clone(),
        Err(_) => {
            report_error("video_track mutex poisoned");
            return;
        }
    };
    let audio_track = match session.audio_track.lock() {
        Ok(t) => t.clone(),
        Err(_) => {
            report_error("audio_track mutex poisoned");
            return;
        }
    };
    if let Err(e) = pc
        .add_track(video_track as Arc<dyn TrackLocal + Send + Sync>)
        .await
    {
        tracing::error!("[SDP] guest add video track failed: {e}");
        report_error(&e.to_string());
        return;
    }
    if let Err(e) = pc
        .add_track(audio_track as Arc<dyn TrackLocal + Send + Sync>)
        .await
    {
        tracing::error!("[SDP] guest add audio track failed: {e}");
        report_error(&e.to_string());
        return;
    }

    // SDP exchange on guest PC
    let answer = match webrtc::exchange_sdp_on_pc(&pc, sdp).await {
        Ok(a) => a,
        Err(e) => {
            tracing::error!("[SDP] guest exchange failed: {e}");
            report_error(&e);
            return;
        }
    };

    tracing::info!("[SDP] guest exchange OK ({} chars)", answer.len());
    signal_log(
        "guest_offer",
        "sdp_answer_created",
        &format!(
            "game_id={} sdp_answer_length={}",
            session.game_id,
            answer.len()
        ),
    );

    // The gateway binds peer_role and peer_seat to the validated peer token.
    // Keep a display-only fallback for old commands, but never grant input
    // authority without an explicit player role and authoritative seat.
    let local_players = session
        .local_players
        .load(std::sync::atomic::Ordering::Relaxed);
    let fallback_seat = {
        let guests = session.guests.lock().await;
        guests.len() as u32 + local_players
    };
    let seat = peer_seat.unwrap_or(fallback_seat);

    // Store guest peer
    let guest = Arc::new(crate::session::GuestPeer {
        pc,
        peer_token: peer_token.to_string(),
    });
    session.guests.lock().await.push(Arc::clone(&guest));

    // Wire DC handler with the role and seat authenticated by sc-web.
    wire_dc_handler_for_guest(session, peer_token, seat, &peer_role, peer_seat).await;

    // Send SDP answer back via notify_sdp
    let worker_url = worker_url(&session.game_id);
    let cmd_session_id = cmd.payload.get("session_id").and_then(|v| v.as_str());
    if let Err(e) = client
        .notify_sdp(
            &cmd.id,
            &cmd.lease_token,
            &worker_url,
            &session.game_id,
            &answer,
            cmd_session_id,
        )
        .await
    {
        tracing::error!("[SDP] guest notify_sdp failed: {e:#}");
    } else {
        signal_log(
            "guest_offer",
            "notify_sdp_sent",
            &format!(
                "command_id={} game_id={} seat={} sdp_answer_length={}",
                cmd.id,
                session.game_id,
                seat,
                answer.len()
            ),
        );
        tracing::info!(
            "[SDP] guest answer sent ({} chars, seat={})",
            answer.len(),
            seat
        );
    }
}

/// Wire a DataChannel handler for a guest peer.
/// Guest input routes to the assigned seat (not port 0).
/// Guests cannot save/load/list — only the host can.
pub(super) async fn wire_dc_handler_for_guest(
    session: &Arc<GameSession>,
    peer_token: &str,
    seat: u32,
    peer_role: &str,
    authoritative_seat: Option<u32>,
) {
    let session = Arc::clone(session);
    let pc = {
        let guests = session.guests.lock().await;
        guests
            .iter()
            .find(|g| g.peer_token == peer_token)
            .map(|g| g.pc.clone())
    };

    let Some(pc) = pc else {
        tracing::warn!("[DC] guest PC not found for supplied peer capability");
        return;
    };

    let peer_token = peer_token.to_string();
    let _pt_for_close = peer_token.clone();
    let _session_for_close = Arc::clone(&session);
    let pc_for_ice = Arc::clone(&pc);
    let session_for_ice = Arc::clone(&session);
    let pt_for_ice = peer_token.clone();
    let peer_role = peer_role.to_string();

    pc.on_data_channel(Box::new(move |dc: Arc<_>| {
        let session = Arc::clone(&session);
        let pt = peer_token.clone();
        let peer_role = peer_role.clone();
        Box::pin(async move {
            tracing::info!(
                "[DC] guest data channel received: {} (seat={})",
                dc.label(),
                seat
            );

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
                    tracing::info!("[DC] guest disconnected");
                    let mut guests = session.guests.lock().await;
                    guests.retain(|g| g.peer_token != pt);
                })
            }));

            let dc_for_move = Arc::clone(&dc_for_msg);
            dc_for_msg.on_message(Box::new(move |msg| {
                let session = Arc::clone(&session_for_msg);
                let dc = Arc::clone(&dc_for_move);
                let peer_role = peer_role.clone();
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
                        if cmd_str == "save_state"
                            || cmd_str == "load_state"
                            || cmd_str == "list_saves"
                        {
                            return;
                        }
                    }

                    let local_players = session
                        .local_players
                        .load(std::sync::atomic::Ordering::Relaxed);
                    if let Some(command) =
                        guest_input_command(&peer_role, authoritative_seat, local_players, &data)
                    {
                        let guard = session.core_cmd_tx.lock().await;
                        if let Some(ref tx) = *guard {
                            let _ = tx.try_send(command);
                        }
                    } else if data.len() >= 3 && peer_role != "player" {
                        tracing::trace!("[DC] ignored input from role={peer_role}");
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
                if guests.is_empty()
                    && !session_for_ice
                        .host_connected
                        .load(std::sync::atomic::Ordering::Relaxed)
                {
                    tracing::info!("[ICE] last guest left, host gone — cancelling session");
                    session_for_ice.cancel.cancel();
                }
                break;
            }
        }
    });
}

/// After a host reconnect swaps session video/audio tracks, rebind every
/// existing guest peer connection to the fresh tracks.  Without this
/// rebind, the streaming loop writes to the new tracks (which the host
/// PC can see) but existing guest PCs still hold the old track instances,
/// permanently freezing connected guests.
async fn rebind_guest_tracks(
    session: &Arc<GameSession>,
    video_track: Arc<dyn ::webrtc::track::track_local::TrackLocal + Send + Sync>,
    audio_track: Arc<dyn ::webrtc::track::track_local::TrackLocal + Send + Sync>,
) {
    use ::webrtc::track::track_local::TrackLocal;
    let guests = session.guests.lock().await;
    if guests.is_empty() {
        return;
    }
    tracing::info!(
        "[DC] rebinding {} guest(s) to fresh host tracks",
        guests.len()
    );
    for guest in guests.iter() {
        if let Err(e) = guest
            .pc
            .add_track(video_track.clone() as Arc<dyn TrackLocal + Send + Sync>)
            .await
        {
            tracing::error!("[DC] guest video rebind failed: {e}");
        }
        if let Err(e) = guest
            .pc
            .add_track(audio_track.clone() as Arc<dyn TrackLocal + Send + Sync>)
            .await
        {
            tracing::error!("[DC] guest audio rebind failed: {e}");
        }
    }
}

fn guest_input_command(
    peer_role: &str,
    authoritative_seat: Option<u32>,
    local_players: u32,
    data: &[u8],
) -> Option<crate::core_bridge::CoreCommand> {
    if peer_role != "player" || data.len() < 3 {
        return None;
    }

    let guest_index = authoritative_seat?.checked_sub(1)?;
    let seat = local_players.checked_add(guest_index)?;
    let state = data[1] as u16 | ((data[2] as u16) << 8);
    Some(crate::core_bridge::CoreCommand::SetInput { port: seat, state })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn viewer_data_channel_input_cannot_reach_the_core() {
        let command = guest_input_command("viewer", Some(4), 2, &[4, 0x34, 0x12]);

        assert!(command.is_none());
    }

    #[test]
    fn authorized_player_input_uses_the_server_assigned_seat() {
        let command = guest_input_command("player", Some(2), 1, &[99, 0x34, 0x12]);

        assert!(matches!(
            command,
            Some(crate::core_bridge::CoreCommand::SetInput {
                port: 2,
                state: 0x1234
            })
        ));
    }

    #[test]
    fn guest_input_is_offset_past_all_host_local_players() {
        let command = guest_input_command("player", Some(1), 2, &[0, 0x34, 0x12]);

        assert!(matches!(
            command,
            Some(crate::core_bridge::CoreCommand::SetInput {
                port: 2,
                state: 0x1234
            })
        ));
    }

    #[test]
    fn malformed_or_unproven_player_authority_fails_closed() {
        assert!(guest_input_command("player", None, 1, &[1, 0x34, 0x12]).is_none());
        assert!(guest_input_command("host", Some(1), 1, &[1, 0x34, 0x12]).is_none());
        assert!(guest_input_command("player", Some(0), 1, &[1, 0x34, 0x12]).is_none());
        assert!(guest_input_command("player", Some(1), 1, &[1, 0x34]).is_none());
    }

    #[tokio::test]
    async fn recent_history_requires_a_ready_server_local_launch() {
        let directory = tempfile::tempdir().unwrap();
        let store = crate::library_state::LibraryStateStore::load(
            directory.path().join("library-state.json"),
        )
        .unwrap();
        let preferences = Arc::new(tokio::sync::Mutex::new(store));
        let game_id = "local_0123456789abcdef0123456789abcdef";

        record_server_local_play(&preferences, game_id, false, true).await;
        record_server_local_play(&preferences, game_id, true, false).await;
        assert!(
            !preferences
                .lock()
                .await
                .snapshot()
                .recent
                .contains_key(game_id)
        );

        record_server_local_play(&preferences, game_id, true, true).await;
        assert!(
            preferences
                .lock()
                .await
                .snapshot()
                .recent
                .contains_key(game_id)
        );
    }
}
