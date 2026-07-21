//! DataChannel wiring: input dispatch, ICE watcher, disconnect.

use super::*;

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
pub(super) fn wire_dc_handler(session: &Arc<GameSession>) {
    let session = Arc::clone(session);
    let pc = session.pc.lock().expect("mutex poisoned").clone();

    // ── ICE watcher for host PC ────────────────────────────────────
    let pc_for_ice = Arc::clone(&pc);
    let session_for_ice = Arc::clone(&session);
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(std::time::Duration::from_secs(3)).await;
            let state = pc_for_ice.connection_state().to_string();
            if state == "failed" || state == "disconnected" {
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
                let has_guests = !session_for_ice.guests.lock().await.is_empty();
                if !has_guests {
                    tracing::info!("[ICE] host PC dead, no guests — cancelling session");
                    session_for_ice.cancel.cancel();
                } else {
                    tracing::info!(
                        "[ICE] host PC dead, {} guests present — keeping session alive",
                        session_for_ice.guests.lock().await.len()
                    );
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
                                // Extract local_players for multi-gamepad seat offset
                                if let Some(lp) = val.get("local_players").and_then(|v| v.as_u64())
                                {
                                    session
                                        .local_players
                                        .store(lp as u32, std::sync::atomic::Ordering::Relaxed);
                                    tracing::info!("[DC] host reported local_players={}", lp);
                                }
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
