//! Game lifecycle and WebRTC SDP handlers.

use super::*;
use std::collections::HashSet;
use std::sync::Mutex as StdMutex;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};

pub(crate) const MAX_ACTIVE_GUESTS: usize = 8;
pub(crate) const MAX_PENDING_GUEST_EXCHANGES: u32 = 4;

fn guest_admission_allowed(
    active_guests: usize,
    pending_exchanges: u32,
    pending_new_guests: usize,
) -> bool {
    active_guests + pending_new_guests < MAX_ACTIVE_GUESTS
        && pending_exchanges < MAX_PENDING_GUEST_EXCHANGES
}

struct GuestExchangePermit {
    pending: Arc<AtomicU32>,
    pending_tokens: Arc<StdMutex<HashSet<String>>>,
    peer_token: String,
}

impl Drop for GuestExchangePermit {
    fn drop(&mut self) {
        self.pending.fetch_sub(1, Ordering::AcqRel);
        if let Ok(mut tokens) = self.pending_tokens.lock() {
            tokens.remove(&self.peer_token);
        }
    }
}

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

/// The gateway-enriched account identity for a command payload (#745).
///
/// sc-web validates the launch capability (membership + short code) and
/// attaches the authenticated session's `user_id` to `start_game` (and
/// guest SDP) commands. This is the ONLY trusted identity source — a
/// client-sent `account_id` in the DC auth message is advisory at best
/// and never authoritative.
pub(super) fn payload_account_id(cmd: &sc_web::Command) -> Option<String> {
    cmd.payload
        .get("user_id")
        .and_then(|value| value.as_str())
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
}

/// Whether the command requests a resident session (never idle-killed,
/// periodically checkpointed). Driven by the gateway's always_on flag.
fn is_resident(cmd: &sc_web::Command) -> bool {
    cmd.payload.get("resident").and_then(|v| v.as_bool()).unwrap_or(false)
}

async fn cleanup_failed_start(
    game_id: &str,
    session: &Arc<GameSession>,
    sessions: &mut HashMap<String, Arc<GameSession>>,
) {
    let stopped = core_bridge::cancel_and_wait_for_core(
        &session.cancel,
        &session.core_stopped,
        Duration::from_secs(2),
    )
    .await;
    if !stopped {
        // Keep the cancelled session as the per-game fence until child reaping.
        tracing::error!("[SESSION] failed launch core did not stop within shutdown deadline");
    } else if sessions
        .get(game_id)
        .is_some_and(|current| Arc::ptr_eq(current, session))
    {
        sessions.remove(game_id);
    }

    close_session_peers(session).await;
}

async fn close_host_peer(session: &Arc<GameSession>) {
    let pc = {
        let _host_guard = session.host_lifecycle.lock().await;
        session.pc.lock().expect("mutex poisoned").clone()
    };
    if let Err(error) = pc.close().await {
        tracing::warn!("[SESSION] host peer close failed: {error}");
    }
}

pub(super) async fn close_session_peers(session: &Arc<GameSession>) {
    session.cancel.cancel();
    close_host_peer(session).await;
    *session.dc.lock().await = None;
    session
        .host_connected
        .store(false, std::sync::atomic::Ordering::Relaxed);
    let guests = {
        let _lifecycle = session.guest_lifecycle.lock().await;
        std::mem::take(&mut *session.guests.lock().await)
    };
    for guest in guests {
        if let Err(error) = guest.pc.close().await {
            tracing::warn!("[SESSION] guest peer close failed: {error}");
        }
    }
}

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

    // Stop and reap any existing runtime before reusing this game's shared-
    // memory names. Starting the replacement early can orphan the old sc-core
    // and make both processes race the same IPC files.
    if let Some(old) = sessions.get(game_id).cloned() {
        signal_log(
            "host_start",
            "previous_session_cancelled",
            &format!("game_id={}", game_id),
        );
        if !core_bridge::cancel_and_wait_for_core(
            &old.cancel,
            &old.core_stopped,
            Duration::from_secs(2),
        )
        .await
        {
            tracing::error!(
                "[SESSION] previous core did not stop; refusing overlapping replacement"
            );
            let _ = client
                .command_result(
                    &cmd.id,
                    &cmd.lease_token,
                    &serde_json::json!({
                        "error": "core_shutdown_timeout",
                        "message": "previous game runtime did not stop cleanly"
                    }),
                )
                .await;
            return;
        }
        close_session_peers(&old).await;
        if old.cloud_session_id.is_some()
            && let Err(error) = client
                .notify_worker_dead(game_id, old.cloud_session_id.as_deref())
                .await
        {
            tracing::warn!("[SESSION] replacement teardown notify failed: {error:#}");
            return;
        }
        if sessions
            .get(game_id)
            .is_some_and(|current| Arc::ptr_eq(current, &old))
        {
            sessions.remove(game_id);
        }
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
        host_lifecycle: tokio::sync::Mutex::new(()),
        guests: tokio::sync::Mutex::new(Vec::new()),
        guest_lifecycle: tokio::sync::Mutex::new(()),
        pending_guest_exchanges: std::sync::Arc::new(std::sync::atomic::AtomicU32::new(0)),
        pending_guest_tokens: std::sync::Arc::new(std::sync::Mutex::new(std::collections::HashSet::new())),
        host_connected: AtomicBool::new(false),
        claimed_peer: tokio::sync::Mutex::new(None),
        local_players: std::sync::atomic::AtomicU32::new(1),
        // #745: identity comes from the gateway-enriched start_game payload
        // (membership + short-code validated), never from the browser.
        account_id: tokio::sync::Mutex::new(payload_account_id(cmd)),
        core_started: std::sync::atomic::AtomicBool::new(false),
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
        resident: AtomicBool::new(is_resident(cmd)),
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
        tracing::error!("[SESSION] core startup failed: {error}");
        cleanup_failed_start(game_id, &session, sessions).await;
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
    let stream_cancel = session.cancel.clone();
    tokio::spawn(async move {
        streaming::run_stream(stream_session).await;
        // Encoder/push failures must tear down a runtime that no longer drains.
        stream_cancel.cancel();
    });

    // Store session (clone before moving into HashMap)
    sessions.insert(game_id.to_string(), Arc::clone(&session));
    let t3 = std::time::Instant::now();

    // Notify sc-web — include SDP answer if offer was provided
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
                                    let old_pc = {
                                        let _host_guard = session.host_lifecycle.lock().await;
                                        let mut current = session.pc.lock().expect("mutex poisoned");
                                        std::mem::replace(&mut *current, fresh.pc)
                                    };
                                    if let Err(error) = old_pc.close().await {
                                        tracing::warn!("[SESSION] failed host peer close failed: {error}");
                                    }
                                    *session.video_track.lock().expect("mutex poisoned") =
                                        fresh.video_track;
                                    *session.audio_track.lock().expect("mutex poisoned") =
                                        fresh.audio_track;
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
                                    let old_pc = {
                                        let _host_guard = session.host_lifecycle.lock().await;
                                        let mut current = session.pc.lock().expect("mutex poisoned");
                                        std::mem::replace(&mut *current, fresh.pc)
                                    };
                                    if let Err(error) = old_pc.close().await {
                                        tracing::warn!("[SESSION] failed host peer close failed: {error}");
                                    }
                                    // Swap tracks too — the streaming loop references them
                                    *session.video_track.lock().expect("mutex poisoned") =
                                        fresh.video_track;
                                    *session.audio_track.lock().expect("mutex poisoned") =
                                        fresh.audio_track;
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
                    cleanup_failed_start(game_id, &session, sessions).await;
                    return;
                } else {
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
                cleanup_failed_start(game_id, &session, sessions).await;
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
            cleanup_failed_start(game_id, &session, sessions).await;
            return;
        } else {
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

    record_server_local_play(library_preferences, game_id, true, server_local).await;

    // ── Resident checkpoint timer ────────────────────────────────────
    // Resident sessions save state every 5 minutes so crash recovery
    // resumes near where playback left off.
    // TODO: send CoreCommand::SaveState + persist via save_stack_push.
    if session.resident.load(std::sync::atomic::Ordering::Relaxed) {
        let chk_session = Arc::clone(&session);
        let chk_cancel = session.cancel.clone();
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(Duration::from_secs(300));
            interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            loop {
                tokio::select! {
                    _ = chk_cancel.cancelled() => break,
                    _ = interval.tick() => {
                        tracing::debug!(
                            "[CHKPT] resident tick for {} — checkpoint TODO",
                            chk_session.game_id,
                        );
                    }
                }
            }
        });
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
        if matches_current && let Some(session) = sessions.get(game_id).cloned() {
            if core_bridge::cancel_and_wait_for_core(
                &session.cancel,
                &session.core_stopped,
                Duration::from_secs(2),
            )
            .await
            {
                close_session_peers(&session).await;
                stopped = true;
            } else {
                tracing::error!("[POLL] stop_game core shutdown timed out for {game_id}");
                // Keep both the command lease and per-game tombstone retryable.
                // Once core_stopped fires, dead-session cleanup durably notifies
                // sc-web before removing the authoritative local fence.
                return;
            }
        } else if sessions.contains_key(game_id) {
            tracing::warn!("[POLL] ignoring stale stop for a superseded game session");
            let _ = client
                .notify_stop(&cmd.id, &cmd.lease_token, game_id, Some(target_session_id))
                .await;
        } else {
            tracing::info!("[POLL] stop_game for absent runtime {game_id}; converging cloud state");
            let _ = client
                .notify_stop(&cmd.id, &cmd.lease_token, game_id, Some(target_session_id))
                .await;
        }
    } else {
        tracing::warn!("[POLL] stop_game command missing exact cloud session id");
        // Can't act without a session ID — mark failed so it doesn't retry.
        let _ = client
            .command_result(
                &cmd.id,
                &cmd.lease_token,
                &serde_json::json!({"ok": false, "error": "missing session_id"}),
            )
            .await;
    }
    if stopped {
        match client
            .notify_stop(&cmd.id, &cmd.lease_token, game_id, target_session_id)
            .await
        {
            Ok(()) => {
                if let Some(session) = sessions.get(game_id)
                    && session.cloud_session_id.as_deref() == target_session_id
                {
                    sessions.remove(game_id);
                }
            }
            Err(error) => {
                tracing::warn!("[POLL] notify_stop failed for {game_id}: {error:#}");
                // Keep the cancelled/reaped session as a durable retry tombstone.
            }
        }
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
                        let old_pc = {
                            let _host_guard = session.host_lifecycle.lock().await;
                            let mut current = session.pc.lock().expect("mutex poisoned");
                            std::mem::replace(&mut *current, fresh.pc)
                        };
                        if let Err(error) = old_pc.close().await {
                            tracing::warn!("[SDP] failed superseded host peer close: {error}");
                        }
                        *session.video_track.lock().expect("mutex poisoned") = fresh.video_track;
                        *session.audio_track.lock().expect("mutex poisoned") = fresh.audio_track;
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
                                if let Err(error) = client
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
                                    tracing::error!("[SDP] reconnection notify failed: {error:#}");
                                    close_host_peer(session).await;
                                }
                            }
                            Err(e) => {
                                tracing::error!("[SDP] reconnection exchange failed: {e}");
                                close_host_peer(session).await;
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
                                    let old_pc = {
                                        let _host_guard = session.host_lifecycle.lock().await;
                                        let mut current = session.pc.lock().expect("mutex poisoned");
                                        std::mem::replace(&mut *current, fresh.pc)
                                    };
                                    if let Err(error) = old_pc.close().await {
                                        tracing::warn!("[SDP] failed superseded host peer close: {error}");
                                    }
                                    *session.video_track.lock().expect("mutex poisoned") =
                                        fresh.video_track;
                                    *session.audio_track.lock().expect("mutex poisoned") =
                                        fresh.audio_track;
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
                        close_host_peer(session).await;
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
                    close_host_peer(session).await;
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

fn guest_sdp_has_ice_credentials(sdp: &str) -> bool {
    let has_ufrag = sdp.lines().any(|line| {
        line.strip_prefix("a=ice-ufrag:")
            .is_some_and(|value| !value.trim().is_empty())
    });
    let has_pwd = sdp.lines().any(|line| {
        line.strip_prefix("a=ice-pwd:")
            .is_some_and(|value| !value.trim().is_empty())
    });
    has_ufrag && has_pwd
}

async fn remove_guest_if_current_locked(
    session: &Arc<GameSession>,
    peer_token: &str,
    pc: &Arc<::webrtc::peer_connection::RTCPeerConnection>,
) -> bool {
    let mut guests = session.guests.lock().await;
    let before = guests.len();
    guests.retain(|guest| {
        !(guest.peer_token == peer_token && Arc::ptr_eq(&guest.pc, pc))
    });
    before != guests.len()
}

async fn remove_and_close_guest_if_current_locked(
    session: &Arc<GameSession>,
    peer_token: &str,
    pc: &Arc<::webrtc::peer_connection::RTCPeerConnection>,
) -> bool {
    if !remove_guest_if_current_locked(session, peer_token, pc).await {
        return false;
    }
    if let Err(error) = pc.close().await {
        tracing::warn!("[DC] guest peer close failed: {error}");
    }
    true
}

async fn remove_guest_if_current(
    session: &Arc<GameSession>,
    peer_token: &str,
    pc: &Arc<::webrtc::peer_connection::RTCPeerConnection>,
) -> bool {
    let _lifecycle = session.guest_lifecycle.lock().await;
    remove_guest_if_current_locked(session, peer_token, pc).await
}

async fn admit_guest_exchange(
    session: &Arc<GameSession>,
    peer_token: &str,
) -> Result<GuestExchangePermit, &'static str> {
    let _lifecycle = session.guest_lifecycle.lock().await;
    let guests = session.guests.lock().await;
    let existing = guests.iter().any(|guest| guest.peer_token == peer_token);
    let active_guests = guests.len().saturating_sub(existing as usize);
    let pending = session.pending_guest_exchanges.load(Ordering::Acquire);
    let mut pending_tokens = session
        .pending_guest_tokens
        .lock()
        .map_err(|_| "guest_admission_state_unavailable")?;
    if pending_tokens.contains(peer_token) {
        return Err("guest_exchange_in_progress");
    }
    let pending_new_guests = pending_tokens
        .iter()
        .filter(|token| !guests.iter().any(|guest| &guest.peer_token == *token))
        .count()
        + usize::from(!existing);
    if !guest_admission_allowed(active_guests, pending, pending_new_guests) {
        return Err(if active_guests + pending_new_guests >= MAX_ACTIVE_GUESTS {
            "guest_capacity_exhausted"
        } else {
            "guest_exchange_capacity_exhausted"
        });
    }
    pending_tokens.insert(peer_token.to_string());
    session
        .pending_guest_exchanges
        .fetch_add(1, Ordering::AcqRel);
    Ok(GuestExchangePermit {
        pending: Arc::clone(&session.pending_guest_exchanges),
        pending_tokens: Arc::clone(&session.pending_guest_tokens),
        peer_token: peer_token.to_string(),
    })
}

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

    if !guest_sdp_has_ice_credentials(sdp) {
        tracing::warn!("[SDP] guest offer missing ICE credentials — rejecting before PC creation");
        let _ = client
            .command_result(
                &cmd.id,
                &cmd.lease_token,
                &serde_json::json!({"error": "malformed_guest_sdp"}),
            )
            .await;
        return;
    }

    let _exchange_permit = match admit_guest_exchange(session, peer_token).await {
        Ok(permit) => permit,
        Err(error) => {
            tracing::warn!("[SDP] guest offer rejected by admission control: {error}");
            let _ = client
                .command_result(
                    &cmd.id,
                    &cmd.lease_token,
                    &serde_json::json!({"error": error}),
                )
                .await;
            return;
        }
    };

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
            let _ = pc.close().await;
            return;
        }
    };
    let audio_track = match session.audio_track.lock() {
        Ok(t) => t.clone(),
        Err(_) => {
            report_error("audio_track mutex poisoned");
            let _ = pc.close().await;
            return;
        }
    };
    if let Err(e) = pc
        .add_track(video_track as Arc<dyn TrackLocal + Send + Sync>)
        .await
    {
        tracing::error!("[SDP] guest add video track failed: {e}");
        report_error(&e.to_string());
        let _ = pc.close().await;
        return;
    }
    if let Err(e) = pc
        .add_track(audio_track as Arc<dyn TrackLocal + Send + Sync>)
        .await
    {
        tracing::error!("[SDP] guest add audio track failed: {e}");
        report_error(&e.to_string());
        let _ = pc.close().await;
        return;
    }

    // SDP exchange on guest PC
    let answer = match webrtc::exchange_sdp_on_pc(&pc, sdp).await {
        Ok(a) => a,
        Err(e) => {
            tracing::error!("[SDP] guest exchange failed: {e}");
            report_error(&e);
            let _ = pc.close().await;
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

    let guest = Arc::new(crate::session::GuestPeer {
        pc,
        peer_token: peer_token.to_string(),
        role: peer_role.clone(),
    });

    // Replace the old peer atomically with this capability's new PC. Closing
    // old PCs happens after releasing the list lock so callbacks cannot race
    // the identity decision and delete the replacement.
    let stale_guests = {
        let _lifecycle = session.guest_lifecycle.lock().await;
        let mut guests = session.guests.lock().await;
        let mut stale = Vec::new();
        guests.retain(|existing| {
            if existing.peer_token == peer_token {
                stale.push(Arc::clone(existing));
                false
            } else {
                true
            }
        });
        guests.push(Arc::clone(&guest));
        stale
    };
    for stale in stale_guests {
        let _ = stale.pc.close().await;
    }

    // Wire DC handler with the role and seat authenticated by sc-web.
    wire_dc_handler_for_guest(session, &guest, seat, &peer_role, peer_seat).await;

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
        if remove_guest_if_current(session, peer_token, &guest.pc).await {
            let _ = guest.pc.close().await;
        }
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
    guest: &Arc<crate::session::GuestPeer>,
    seat: u32,
    peer_role: &str,
    authoritative_seat: Option<u32>,
) {
    let session = Arc::clone(session);
    let pc = Arc::clone(&guest.pc);
    let peer_token = guest.peer_token.clone();
    let pc_for_close = Arc::clone(&pc);
    let pc_for_ice = Arc::clone(&pc);
    let session_for_ice = Arc::clone(&session);
    let pt_for_ice = peer_token.clone();
    let peer_role = peer_role.to_string();

    pc.on_data_channel(Box::new(move |dc: Arc<_>| {
        let session = Arc::clone(&session);
        let pc_for_close = Arc::clone(&pc_for_close);
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
                let pc_for_close = Arc::clone(&pc_for_close);
                Box::pin(async move {
                    tracing::info!("[DC] guest disconnected");
                    let _lifecycle = session.guest_lifecycle.lock().await;
                    if !remove_and_close_guest_if_current_locked(
                        &session,
                        &pt,
                        &pc_for_close,
                    )
                    .await
                    {
                        // This callback belongs to a superseded PC. Never let
                        // it remove or release state for the replacement peer.
                        return;
                    }
                    // If the departing peer was the claimer, release the claim
                    // so the next viewer can grab the cabinet.
                    let mut claimed = session.claimed_peer.lock().await;
                    if claimed.as_deref() == Some(pt.as_str()) {
                        tracing::info!("[DC] arcade: claim released (claimer left)");
                        *claimed = None;
                    }
                })
            }));

            let dc_for_move = Arc::clone(&dc_for_msg);
            dc_for_msg.on_message(Box::new(move |msg| {
                let session = Arc::clone(&session_for_msg);
                let dc = Arc::clone(&dc_for_move);
                let peer_role = peer_role.clone();
                let pt = pt.clone();
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
                        // Heartbeat / any other JSON control message (ping,
                        // state queries, etc.) must NEVER be interpreted as
                        // binary input — a JSON doc's leading bytes would
                        // otherwise be parsed as [seat, state_lo, state_hi]
                        // and inject phantom button presses into the core
                        // (e.g. {"cmd":"ping",...} → 0x6322 = 6 buttons).
                        // Discriminate on the transport: text frames are
                        // commands; binary frames are input. A binary input
                        // frame may coincidentally parse as a JSON array, so
                        // only swallow STRING messages here.
                        if !is_binary_input_frame(msg.is_string, &data) {
                            return;
                        }
                    }

                    let local_players = session
                        .local_players
                        .load(std::sync::atomic::Ordering::Relaxed);

                    let resident_no_host = session
                        .resident
                        .load(std::sync::atomic::Ordering::Relaxed)
                        && !session
                            .host_connected
                            .load(std::sync::atomic::Ordering::Relaxed);

                    // Only a real button press (non-zero state) may claim the
                    // cabinet — idle gamepad polls send [seat, 0, 0] every
                    // frame and must not grab the seat for a spectator.
                    let actual_press = data.len() >= 3 && (data[1] != 0 || data[2] != 0);

                    // Arcade mode: the FIRST viewer button press claims the
                    // player slot for THAT peer only (deferred input), and
                    // ONLY when no gateway-assigned player is connected —
                    // a spectator must never hijack an active player's seat
                    // or inject input into a game someone is already playing.
                    // After the claim, only the claiming peer's input is
                    // treated as player input; other viewers remain
                    // spectators and their input is dropped. The claim is
                    // released when the claimer disconnects.
                    let effective_role: std::borrow::Cow<'_, str> =
                        if peer_role == "player" {
                            std::borrow::Cow::Borrowed("player")
                        } else if resident_no_host {
                            let player_guest_present = {
                                let guests = session.guests.lock().await;
                                guests.iter().any(|g| g.role == "player")
                            };
                            if player_guest_present {
                                std::borrow::Cow::Borrowed("viewer")
                            } else {
                                let mut claimed = session.claimed_peer.lock().await;
                                match claimed.as_deref() {
                                    None if actual_press => {
                                        tracing::info!(
                                            "[DC] arcade: viewer {} claimed player 1 (first input)",
                                            pt
                                        );
                                        *claimed = Some(pt.clone());
                                        std::borrow::Cow::Borrowed("player")
                                    }
                                    // Once claimed, the claimer's FULL input stream
                                    // (including zero-state key releases) must reach
                                    // the core. Dropping state=0 here leaves the key
                                    // permanently pressed in the game — the exact
                                    // "phantom input layered on top of my input"
                                    // symptom on public arcades.
                                    Some(existing) if existing == pt => {
                                        std::borrow::Cow::Borrowed("player")
                                    }
                                    _ => std::borrow::Cow::Borrowed("viewer"),
                                }
                            }
                        } else {
                            std::borrow::Cow::Borrowed(&peer_role)
                        };

                    if let Some(command) = guest_input_command(
                        &effective_role,
                        // Seat-correct mapping. A resident session has no host
                        // browser, so local_players=0: guest seat 1 → port 0
                        // (player 1), seat 2 → port 1 (player 2). A claiming
                        // viewer is the first player → port 0. Previously every
                        // guest was forced to Some(1)/0, so player 2's inputs
                        // also drove player 1 (phantom input).
                        if resident_no_host {
                            if peer_role == "player" {
                                authoritative_seat
                            } else {
                                Some(1u32)
                            }
                        } else {
                            authoritative_seat
                        },
                        if resident_no_host { 0 } else { local_players },
                        &data,
                    ) {
                        let guard = session.core_cmd_tx.lock().await;
                        if let Some(ref tx) = *guard {
                            tracing::debug!(
                                "[DC] guest input forwarded role={effective_role} seat={} state=0x{:04x}",
                                data[0],
                                (data[1] as u16) | ((data[2] as u16) << 8),
                            );
                            let _ = tx.try_send(command);
                        }
                    } else if data.len() >= 3 && effective_role != "player" {
                        tracing::trace!("[DC] ignored input from role={effective_role}");
                    }
                })
            }));
        })
    }));

    // ICE disconnect watcher — if guest PC fails, remove it
    let guest_cancel = session_for_ice.cancel.clone();
    tokio::spawn(async move {
        loop {
            tokio::select! {
                _ = guest_cancel.cancelled() => {
                    let _ = pc_for_ice.close().await;
                    break;
                },
                _ = tokio::time::sleep(std::time::Duration::from_secs(3)) => {}
            }
            let state = pc_for_ice.connection_state().to_string();
            if state == "failed" || state == "disconnected" || state == "closed" {
                let _lifecycle = session_for_ice.guest_lifecycle.lock().await;
                let removed = remove_guest_if_current_locked(
                    &session_for_ice,
                    &pt_for_ice,
                    &pc_for_ice,
                )
                .await;
                if !removed {
                    // This watcher belongs to a superseded PC.
                    break;
                }
                let _ = pc_for_ice.close().await;
                let guest_count = session_for_ice.guests.lock().await.len();
                if guest_count == 0 {
                    // Arcade: release the claimed seat so next viewer can grab it
                    *session_for_ice.claimed_peer.lock().await = None;
                } else {
                    // The claimer left but other viewers remain — release the
                    // claim only if THIS peer was the claimer, so the next
                    // viewer can claim.
                    let mut claimed = session_for_ice.claimed_peer.lock().await;
                    if claimed.as_deref() == Some(pt_for_ice.as_str()) {
                        *claimed = None;
                    }
                }
                if guest_count == 0
                    && !session_for_ice
                        .host_connected
                        .load(std::sync::atomic::Ordering::Relaxed)
                    && !session_for_ice
                        .resident
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

/// Classify a DataChannel frame: JSON control messages (ping, auth,
/// save/load, …) are handled separately and must NEVER reach the binary
/// input parser — their leading bytes (`{`, `"`, …) would be decoded as a
/// bogus [seat, state_lo, state_hi] and inject phantom button presses into
/// the core. Binary frames (ArrayBuffer) are game input.
fn is_binary_input_frame(is_string: bool, data: &[u8]) -> bool {
    if is_string {
        return false;
    }
    // Binary input frames are 3+ bytes; JSON docs always start with a
    // structural byte (`{`, `[`, `"`, digit…). A binary input frame can
    // coincidentally look like JSON (e.g. [4, 0x34, 0x12] parses as an
    // array) — so only treat text frames as commands, never binary.
    data.len() >= 3
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn peer_cleanup_test_session() -> (Arc<GameSession>, Arc<::webrtc::peer_connection::RTCPeerConnection>) {
        let host = crate::webrtc::build_session_pc_lan().await.unwrap();
        let guest = crate::webrtc::build_session_pc_lan().await.unwrap();
        let guest_pc = Arc::clone(&guest.pc);
        let session = Arc::new(GameSession {
            game_id: "cleanup-test".into(),
            cloud_session_id: Some("cloud-session".into()),
            cancel: tokio_util::sync::CancellationToken::new(),
            core_stopped: tokio_util::sync::CancellationToken::new(),
            pc: std::sync::Mutex::new(host.pc),
            video_track: std::sync::Mutex::new(host.video_track),
            audio_track: std::sync::Mutex::new(host.audio_track),
            dc: tokio::sync::Mutex::new(None),
            host_lifecycle: tokio::sync::Mutex::new(()),
            guests: tokio::sync::Mutex::new(vec![Arc::new(crate::session::GuestPeer {
                pc: guest.pc,
                peer_token: "guest".into(),
                role: "viewer".into(),
            })]),
            guest_lifecycle: tokio::sync::Mutex::new(()),
            pending_guest_exchanges: Arc::new(std::sync::atomic::AtomicU32::new(0)),
            pending_guest_tokens: Arc::new(std::sync::Mutex::new(std::collections::HashSet::new())),
            host_connected: std::sync::atomic::AtomicBool::new(true),
            claimed_peer: tokio::sync::Mutex::new(None),
            local_players: std::sync::atomic::AtomicU32::new(1),
            account_id: tokio::sync::Mutex::new(None),
            core_started: std::sync::atomic::AtomicBool::new(false),
            core_loaded: std::sync::atomic::AtomicBool::new(false),
            core_loading: std::sync::atomic::AtomicBool::new(false),
            core_cmd_tx: tokio::sync::Mutex::new(None),
            core_frame_rx: tokio::sync::Mutex::new(None),
            core_response_rx: tokio::sync::Mutex::new(None),
            video_enc: tokio::sync::Mutex::new(None),
            audio_enc: tokio::sync::Mutex::new(None),
            rom_hash: tokio::sync::Mutex::new(None),
            core_width: tokio::sync::Mutex::new(0),
            core_height: tokio::sync::Mutex::new(0),
            core_fps: tokio::sync::Mutex::new(0.0),
            core_sample_rate: tokio::sync::Mutex::new(48_000.0),
            resident: std::sync::atomic::AtomicBool::new(false),
        });
        (session, guest_pc)
    }

    #[tokio::test]
    async fn terminal_cleanup_closes_host_and_guest_peers() {
        let (session, guest_pc) = peer_cleanup_test_session().await;
        let host_pc = session.pc.lock().expect("mutex poisoned").clone();

        close_session_peers(&session).await;

        assert!(session.cancel.is_cancelled());
        assert!(session.guests.lock().await.is_empty());
        assert!(!session.host_connected.load(std::sync::atomic::Ordering::Relaxed));
        assert_eq!(host_pc.connection_state().to_string(), "closed");
        assert_eq!(guest_pc.connection_state().to_string(), "closed");
    }

    #[tokio::test]
    async fn removing_guest_on_dc_close_closes_the_unlisted_peer() {
        let (session, guest_pc) = peer_cleanup_test_session().await;
        let _lifecycle = session.guest_lifecycle.lock().await;

        assert!(remove_and_close_guest_if_current_locked(&session, "guest", &guest_pc).await);
        assert!(session.guests.lock().await.is_empty());
        assert_eq!(guest_pc.connection_state().to_string(), "closed");
    }

    #[test]
    fn guest_sdp_without_ice_credentials_is_rejected_before_pc_creation() {
        let malformed = "v=0\r\na=group:BUNDLE 0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\n";
        assert!(!guest_sdp_has_ice_credentials(malformed));
    }

    #[test]
    fn guest_sdp_with_ice_credentials_is_eligible_for_exchange() {
        let offer = "v=0\r\na=ice-ufrag:abc123\r\na=ice-pwd:secret123\r\n";
        assert!(guest_sdp_has_ice_credentials(offer));
    }

    #[test]
    fn guest_sdp_requires_both_ice_credentials() {
        assert!(!guest_sdp_has_ice_credentials("a=ice-ufrag:abc\r\n"));
        assert!(!guest_sdp_has_ice_credentials("a=ice-pwd:secret\r\n"));
        assert!(!guest_sdp_has_ice_credentials("a=ice-ufrag: \r\na=ice-pwd:\t\r\n"));
    }

    #[test]
    fn viewer_data_channel_input_cannot_reach_the_core() {
        let command = guest_input_command("viewer", Some(4), 2, &[4, 0x34, 0x12]);

        assert!(command.is_none());
    }

    #[test]
    fn json_ping_bytes_are_not_forwarded_as_player_input() {
        // Regression: the browser sends {"cmd":"ping",...} on the same DC
        // every 2s (PING_INTERVAL_MS). If those text bytes reach the binary
        // input parser, the leading `{"c` (0x7B 0x22 0x63) is decoded as
        // state=0x6322 — six phantom button presses injected into the core
        // every 2 seconds on public arcades. Text frames (JSON commands)
        // must be classified as control messages, never binary input.
        let ping = b"{\"cmd\":\"ping\",\"seq\":1,\"client_ts\":123.45}".to_vec();
        assert!(!is_binary_input_frame(true, &ping), "ping text must not be input");

        // A binary input frame is still input even if its bytes happen to
        // parse as a JSON array.
        let input = [4u8, 0x34, 0x12];
        assert!(is_binary_input_frame(false, &input));
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
    fn arcade_resident_guest_without_host_maps_to_port_zero() {
        // #762: a resident session has no host browser, so local_players
        // offset is 0 — the first guest must land on port 0 (player 1).
        let command = guest_input_command("player", Some(1), 0, &[1, 0x34, 0x12]);

        assert!(matches!(
            command,
            Some(crate::core_bridge::CoreCommand::SetInput {
                port: 0,
                state: 0x1234
            })
        ));
    }

    #[test]
    fn second_player_seat_maps_to_port_one_not_zero() {
        // #762 phantom input: every resident guest was forced to
        // authoritative_seat=Some(1)/local_players=0, so player 2's
        // inputs also drove player 1. Seat 2 must map to port 1.
        let command = guest_input_command("player", Some(2), 0, &[2, 0x34, 0x12]);

        assert!(matches!(
            command,
            Some(crate::core_bridge::CoreCommand::SetInput {
                port: 1,
                state: 0x1234
            })
        ));
    }

    #[test]
    fn non_claiming_viewer_input_is_dropped_not_promoted() {
        // #762 phantom input: the old claim block `{ ...; true }` promoted
        // EVERY viewer's input to "player" on resident sessions. A viewer
        // who is not the claimer must produce no input command.
        assert!(guest_input_command("viewer", Some(1), 0, &[1, 0x34, 0x12]).is_none());
    }

    #[test]
    fn claiming_viewer_maps_to_port_zero() {
        // The deferred-claim feature: a viewer who claims becomes player 1
        // → port 0 (the claim path passes Some(1)/0 to guest_input_command).
        let command = guest_input_command("player", Some(1), 0, &[1, 0x34, 0x12]);
        assert!(matches!(
            command,
            Some(crate::core_bridge::CoreCommand::SetInput {
                port: 0,
                state: 0x1234
            })
        ));
    }

    #[test]
    fn guest_admission_rejects_full_active_and_pending_limits() {
        assert!(guest_admission_allowed(0, 0, 0));
        assert!(!guest_admission_allowed(MAX_ACTIVE_GUESTS, 0, 0));
        assert!(!guest_admission_allowed(0, MAX_PENDING_GUEST_EXCHANGES, 0));
    }

    #[test]
    fn guest_admission_reserves_slots_for_pending_new_guests() {
        assert!(guest_admission_allowed(7, 0, 0));
        assert!(!guest_admission_allowed(7, 1, 1));
        assert!(!guest_admission_allowed(6, 2, 2));
        assert!(guest_admission_allowed(6, 2, 1));
    }

    #[test]
    fn guest_admission_allows_capacity_boundary() {
        assert!(guest_admission_allowed(
            MAX_ACTIVE_GUESTS - 1,
            MAX_PENDING_GUEST_EXCHANGES - 1,
            0
        ));
    }
    #[test]
    fn malformed_or_unproven_player_authority_fails_closed() {
        assert!(guest_input_command("player", None, 1, &[1, 0x34, 0x12]).is_none());
        assert!(guest_input_command("host", Some(1), 1, &[1, 0x34, 0x12]).is_none());
        assert!(guest_input_command("player", Some(0), 1, &[1, 0x34, 0x12]).is_none());
        assert!(guest_input_command("player", Some(1), 1, &[1, 0x34]).is_none());
    }

    #[test]
    fn start_game_payload_carries_gateway_authoritative_account_id() {
        // #745: the gateway enriches start_game with the authenticated
        // session's user_id — the ONLY trusted identity source.
        let cmd = sc_web::Command {
            id: "cmd-1".into(),
            command_type: "start_game".into(),
            payload: serde_json::json!({
                "game_id": "counter",
                "session_id": "sess-1",
                "user_id": "alice-account",
                "sdp": "v=0",
            }),
            lease_token: "lease-1".into(),
            lease_expires_at: "2026-01-01T00:00:00Z".into(),
            attempt: 1,
        };
        assert_eq!(payload_account_id(&cmd).as_deref(), Some("alice-account"));
    }

    #[test]
    fn start_game_without_user_id_falls_back_to_shared() {
        // Anonymous LAN play (L1): no gateway enrichment → no account →
        // "shared" fallback keeps pre-auth SRAM working.
        let cmd = sc_web::Command {
            id: "cmd-2".into(),
            command_type: "start_game".into(),
            payload: serde_json::json!({ "game_id": "counter", "session_id": "sess-2" }),
            lease_token: "lease-2".into(),
            lease_expires_at: "2026-01-01T00:00:00Z".into(),
            attempt: 1,
        };
        assert!(payload_account_id(&cmd).is_none());
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
