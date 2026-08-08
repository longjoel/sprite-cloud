//! DataChannel wiring: input dispatch, ICE watcher, disconnect.

use super::*;

/// Decide whether the ICE watcher should tear down the session.
///
/// The host DataChannel being open (`host_dc_open`) is ground truth that the
/// browser is alive: SCTP heartbeats ride the same ICE transport, so if the
/// browser were truly gone the DC would have closed (and `host_connected`
/// would be false). ICE `disconnected` is a *recoverable* state — the agent
/// keeps trying and may return to `connected` — so it must never cancel a
/// session whose host DC is still open. This is the #735 regression: on
/// same-machine play the server-side `last_received` goes stale (mDNS +
/// QueryOnly consent-check misattribution) and the connection_state flips to
/// `disconnected` ~3s after connect while the browser is happily streaming.
///
/// Guests always keep the session alive, matching prior behavior.
pub(crate) fn should_cancel_ice_watch(
    host_dc_open: bool,
    ice_state: &str,
    has_guests: bool,
) -> bool {
    if has_guests {
        return false;
    }
    if host_dc_open {
        return false;
    }
    ice_state == "failed" || ice_state == "disconnected"
}

// ── DC handler wiring ────────────────────────────────────────────────

/// Parse an auth message's identity fields onto the session (#745).
///
/// Extracts `local_players` (multi-gamepad seat offset) and `account_id`
/// (artifact attribution). Returns the parsed values for tests.
pub(crate) async fn apply_auth_identity(
    session: &Arc<GameSession>,
    val: &serde_json::Value,
) -> (u32, Option<String>) {
    let local_players = val
        .get("local_players")
        .and_then(|v| v.as_u64())
        .map(|lp| {
            session
                .local_players
                .store(lp as u32, std::sync::atomic::Ordering::Relaxed);
            tracing::info!("[DC] host reported local_players={}", lp);
            lp as u32
        })
        .unwrap_or(1);

    let account_id = val
        .get("account_id")
        .and_then(|v| v.as_str())
        .map(|acct| acct.to_string());

    if let Some(ref acct) = account_id {
        *session.account_id.lock().await = Some(acct.clone());
        tracing::info!("[DC] host account_id set ({})", acct);
    }

    (local_players, account_id)
}

/// Wire the browser's non-negotiated DataChannel to core input commands.
///
/// The browser creates a DataChannel labeled "diagnostics" (non-negotiated).
/// We receive it via `pc.on_data_channel()` and parse:
/// - JSON: `{"cmd":"auth"}` → responds with `{"cmd":"auth_ok"}`
/// - JSON save commands: save_state, load_state, list_saves, load_state_at
/// - Binary 3 bytes: `[seat, state_lo, state_hi]` → `SetInput { port, state }`
///
/// Called once on session creation and again on SDP retry when the PC is swapped.
pub(crate) fn wire_dc_handler(session: &Arc<GameSession>) {
    let session = Arc::clone(session);
    let pc = session.pc.lock().expect("mutex poisoned").clone();

    // ── ICE watcher for host PC ────────────────────────────────────
    // Poll connection_state every 3s. Cancel only when the host
    // DataChannel is closed (browser truly gone) AND the ICE state is
    // bad. An open host DC means the browser is alive — `disconnected`
    // is a recoverable state and must not tear down the session
    // (#735: same-machine play flips server-side state to
    // `disconnected` ~3s after connect while media flows fine).
    let pc_for_ice = Arc::clone(&pc);
    let session_for_ice = Arc::clone(&session);
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(std::time::Duration::from_secs(3)).await;
            let state = pc_for_ice.connection_state().to_string();
            let host_dc_open = session_for_ice
                .host_connected
                .load(std::sync::atomic::Ordering::Relaxed);
            let has_guests = !session_for_ice.guests.lock().await.is_empty();
            if !should_cancel_ice_watch(host_dc_open, &state, has_guests) {
                continue;
            }
            tracing::warn!("[ICE] host PC {} — notifying browser", state);
            session_for_ice
                .host_connected
                .store(false, std::sync::atomic::Ordering::Relaxed);
            // Send error over DC so the browser triggers reconnection.
            // Closing the DC alone doesn't change connectionState reliably.
            if let Some(ref dc) = *session_for_ice.dc.lock().await {
                let msg = serde_json::json!({"cmd":"error","reason":"ice failed"});
                let _ = dc.send_text(msg.to_string()).await;
            }
            if has_guests {
                tracing::info!(
                    "[ICE] host PC dead, {} guests present — keeping session alive",
                    session_for_ice.guests.lock().await.len()
                );
                break;
            }
            // Resident sessions (always_on) stay alive indefinitely.
            if session_for_ice
                .resident
                .load(std::sync::atomic::Ordering::Relaxed)
            {
                tracing::info!("[ICE] host PC dead, no guests — but resident session stays alive");
                break;
            }
            tracing::info!("[ICE] host PC dead, no guests — cancelling session");
            session_for_ice.cancel.cancel();
            break;
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

            // The SCTP data channel may close independently while audio/video ICE
            // remains healthy (observed on Android Chrome). Do not tear down media
            // here; the peer-connection ICE callbacks own session liveness.
            let session_close = Arc::clone(&session);
            dc_for_open.on_close(Box::new(move || {
                let session = Arc::clone(&session_close);
                Box::pin(async move {
                    tracing::warn!("[DC] host DC closed — preserving media until ICE disconnects");
                    session
                        .host_connected
                        .store(false, std::sync::atomic::Ordering::Relaxed);
                    *session.dc.lock().await = None;
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
                    tracing::info!(
                        "[DC] browser msg: {} bytes is_string={}",
                        data.len(),
                        msg.is_string
                    );

                    if let Ok(val) = serde_json::from_slice::<serde_json::Value>(&data) {
                        let cmd = val.get("cmd").and_then(|v| v.as_str()).unwrap_or("");

                        match cmd {
                            "auth" => {
                                tracing::info!("[DC] auth received, sending ack");
                                // Extract identity fields for seat offset + artifact
                                // attribution (#745).
                                apply_auth_identity(&session, &val).await;
                                let ack = serde_json::json!({"cmd": "auth_ok"});
                                let _ = dc.send_text(ack.to_string()).await;
                                // Store DC for crash notification, mark host connected
                                *session.dc.lock().await = Some(Arc::clone(&dc));
                                session
                                    .host_connected
                                    .store(true, std::sync::atomic::Ordering::Relaxed);
                                return;
                            }
                            "save_state" => {
                                save_handlers::handle_save_state(&session, &dc).await;
                                return;
                            }
                            "load_state" => {
                                let index =
                                    val.get("index").and_then(|v| v.as_u64()).map(|i| i as u32);
                                save_handlers::handle_load_state(&session, &dc, index).await;
                                return;
                            }
                            "list_saves" => {
                                save_handlers::handle_list_saves(&session, &dc).await;
                                return;
                            }
                            _ => {}
                        }
                    }

                    if data.len() >= 3 {
                        let seat = data[0] as u32;
                        let state = data[1] as u16 | ((data[2] as u16) << 8);
                        if seat > 0 {
                            tracing::trace!("[DC] host input seat={seat} state=0x{state:04x}");
                        }
                        let guard = session.core_cmd_tx.lock().await;
                        if let Some(ref tx) = *guard {
                            let _ = tx
                                .try_send(core_bridge::CoreCommand::SetInput { port: seat, state });
                        }
                    }
                })
            }));
        })
    }));
}

#[cfg(test)]
mod tests {
    use super::{apply_auth_identity, should_cancel_ice_watch};
    use crate::session::GameSession;
    use std::sync::Arc;

    /// #745: an auth message with account_id attributes the session's
    /// artifacts to that account; without it, the `shared` fallback applies.
    #[tokio::test]
    async fn auth_message_sets_account_id_for_artifact_attribution() {
        let stack = crate::webrtc::build_session_pc_lan().await.unwrap();
        let session = Arc::new(GameSession {
            game_id: "g".to_string(),
            cloud_session_id: None,
            cancel: tokio_util::sync::CancellationToken::new(),
            core_stopped: tokio_util::sync::CancellationToken::new(),
            pc: std::sync::Mutex::new(stack.pc),
            video_track: std::sync::Mutex::new(stack.video_track),
            audio_track: std::sync::Mutex::new(stack.audio_track),
            dc: tokio::sync::Mutex::new(None),
            guests: tokio::sync::Mutex::new(Vec::new()),
            host_connected: std::sync::atomic::AtomicBool::new(false),
            local_players: std::sync::atomic::AtomicU32::new(1),
            claimed_peer: tokio::sync::Mutex::new(None),
            resident: std::sync::atomic::AtomicBool::new(false),
            account_id: tokio::sync::Mutex::new(None),
            core_loaded: std::sync::atomic::AtomicBool::new(false),
            core_loading: std::sync::atomic::AtomicBool::new(false),
            core_cmd_tx: tokio::sync::Mutex::new(None),
            core_frame_rx: tokio::sync::Mutex::new(None),
            core_response_rx: tokio::sync::Mutex::new(None),
            video_enc: tokio::sync::Mutex::new(None),
            audio_enc: tokio::sync::Mutex::new(None),
            rom_hash: tokio::sync::Mutex::new(Some("abc".to_string())),
            core_width: tokio::sync::Mutex::new(0),
            core_height: tokio::sync::Mutex::new(0),
            core_fps: tokio::sync::Mutex::new(0.0),
            core_sample_rate: tokio::sync::Mutex::new(48_000.0),
        });

        // With account_id: session is attributed.
        let val = serde_json::json!({"cmd":"auth","local_players":2,"account_id":"alice"});
        let (lp, acct) = apply_auth_identity(&session, &val).await;
        assert_eq!(lp, 2);
        assert_eq!(acct.as_deref(), Some("alice"));
        assert_eq!(session.effective_account_id().await, "alice");

        // Without account_id: shared fallback, seat count still parsed.
        let val2 = serde_json::json!({"cmd":"auth","local_players":1});
        let (lp2, acct2) = apply_auth_identity(&session, &val2).await;
        assert_eq!(lp2, 1);
        assert_eq!(acct2, None);
        // account_id from the earlier message persists.
        assert_eq!(session.effective_account_id().await, "alice");
    }

    #[test]
    fn disconnected_with_open_host_dc_does_not_cancel() {
        // #735 regression: same-machine play flips server-side
        // connection_state to "disconnected" ~3s after connect while the
        // browser is streaming fine. The host DC is open, so the session
        // must NOT be cancelled.
        assert!(!should_cancel_ice_watch(true, "disconnected", false));
    }

    #[test]
    fn failed_with_open_host_dc_does_not_cancel() {
        // Even a transient "failed" reading must not kill a session whose
        // browser DataChannel is demonstrably open.
        assert!(!should_cancel_ice_watch(true, "failed", false));
    }

    #[test]
    fn connected_never_cancels() {
        assert!(!should_cancel_ice_watch(true, "connected", false));
        assert!(!should_cancel_ice_watch(false, "connected", false));
    }

    #[test]
    fn closed_dc_with_bad_ice_cancels_when_no_guests() {
        // Browser truly gone: DC closed AND ICE dead → clean up.
        assert!(should_cancel_ice_watch(false, "failed", false));
        assert!(should_cancel_ice_watch(false, "disconnected", false));
    }

    #[test]
    fn guests_keep_session_alive_even_with_closed_dc() {
        // Prior behavior preserved: guests present → never cancel.
        assert!(!should_cancel_ice_watch(false, "failed", true));
        assert!(!should_cancel_ice_watch(false, "disconnected", true));
    }
}
