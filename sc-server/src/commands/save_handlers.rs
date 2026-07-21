//! Save state and SRAM command handlers.

use super::*;

// ── Save stack command handlers ──────────────────────────────────────

pub(super) async fn handle_save_state(
    session: &Arc<GameSession>,
    dc: &Arc<::webrtc::data_channel::RTCDataChannel>,
) {
    let rh = {
        let guard = session.rom_hash.lock().await;
        guard.clone()
    };
    let Some(rom_hash) = rh else {
        tracing::warn!("[SAVE] no rom_hash — can't save");
        let _ = dc
            .send_text(r#"{"cmd":"save_result","ok":false,"error":"no rom hash"}"#)
            .await;
        return;
    };

    // Dispatch save to core
    {
        let guard = session.core_cmd_tx.lock().await;
        if let Some(ref tx) = *guard {
            let _ = tx.send(core_bridge::CoreCommand::SaveState);
        } else {
            let _ = dc
                .send_text(r#"{"cmd":"save_result","ok":false,"error":"core not loaded"}"#)
                .await;
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
                    let _ = dc
                        .send_text(
                            r#"{"cmd":"save_result","ok":false,"error":"disk write failed"}"#,
                        )
                        .await;
                }
                Err(e) => {
                    tracing::error!("[SAVE] spawn_blocking failed: {e}");
                    let _ = dc
                        .send_text(r#"{"cmd":"save_result","ok":false,"error":"internal error"}"#)
                        .await;
                }
            }
        }
        Some(core_bridge::CoreResponse::SaveStateResult { ok: false, .. }) => {
            tracing::warn!("[SAVE] core returned empty state");
            let _ = dc
                .send_text(r#"{"cmd":"save_result","ok":false,"error":"empty state"}"#)
                .await;
        }
        _ => {
            tracing::warn!("[SAVE] no response from core");
            let _ = dc
                .send_text(r#"{"cmd":"save_result","ok":false,"error":"core timeout"}"#)
                .await;
        }
    }
}

pub(super) async fn handle_load_state(
    session: &Arc<GameSession>,
    dc: &Arc<::webrtc::data_channel::RTCDataChannel>,
    index: Option<u32>,
) {
    let rh = {
        let guard = session.rom_hash.lock().await;
        guard.clone()
    };
    let Some(rom_hash) = rh else {
        let _ = dc
            .send_text(r#"{"cmd":"load_result","ok":false,"error":"no rom hash"}"#)
            .await;
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
    })
    .await
    {
        Ok(Ok(d)) => d,
        Ok(Err(e)) => {
            tracing::warn!("[SAVE] load from disk failed: {e}");
            let _ = dc
                .send_text(format!(
                    r#"{{"cmd":"load_result","ok":false,"error":"{}"}}"#,
                    e
                ))
                .await;
            return;
        }
        Err(e) => {
            tracing::error!("[SAVE] spawn_blocking failed: {e}");
            let _ = dc
                .send_text(r#"{"cmd":"load_result","ok":false,"error":"internal error"}"#)
                .await;
            return;
        }
    };

    if data.is_empty() {
        let _ = dc
            .send_text(r#"{"cmd":"load_result","ok":false,"error":"empty state data"}"#)
            .await;
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
            let _ = dc
                .send_text(r#"{"cmd":"load_result","ok":false,"error":"core not loaded"}"#)
                .await;
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
            let _ = dc
                .send_text(r#"{"cmd":"load_result","ok":false,"error":"core rejected state"}"#)
                .await;
        }
    }
}

pub(super) async fn handle_list_saves(
    session: &Arc<GameSession>,
    dc: &Arc<::webrtc::data_channel::RTCDataChannel>,
) {
    let rh = {
        let guard = session.rom_hash.lock().await;
        guard.clone()
    };
    let Some(rom_hash) = rh else {
        let _ = dc
            .send_text(r#"{"cmd":"list_saves_result","entries":[]}"#)
            .await;
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
            let _ = dc
                .send_text(r#"{"cmd":"list_saves_result","entries":[]}"#)
                .await;
        }
    }
}
