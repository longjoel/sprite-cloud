//! gv-web command polling — runs as a background task in `gv-server local`.
//!
//! When gv_web config is present, this polls gv-web for game commands
//! (start_game, stop_game, sdp_offer, etc.) and executes them using the
//! same worker infrastructure as the local-play API.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use crate::gv_web::GvWebClient;
use crate::worker::SpawnedWorker;

use super::AppState;

/// Run the gv-web command polling loop.
///
/// Shares `AppState` with the local-play HTTP server so workers spawned
/// by either path are tracked in one place.
pub async fn run_poll_loop(
    state: Arc<AppState>,
    client: GvWebClient,
    rom_roots: Vec<String>,
) {
    tracing::info!("[POLL] gv-web polling started — relaying web commands");

    // Track workers spawned BY gv-web (game_id → worker).
    let mut gv_web_workers: HashMap<String, SpawnedWorker> = HashMap::new();

    const POLL_ERROR_BACKOFF_MS: u64 = 5_000;

    loop {
        match client.poll().await {
            Ok(resp) => {
                for cmd in &resp.commands {
                    tracing::info!(
                        "[POLL] command {}: {}",
                        cmd.id,
                        cmd.command_type
                    );

                    match cmd.command_type.as_str() {
                        "start_game" => {
                            let game_id = cmd
                                .payload
                                .get("game_id")
                                .and_then(|v| v.as_str())
                                .unwrap_or("unknown");
                            let host_token = cmd
                                .payload
                                .get("host_token")
                                .and_then(|v| v.as_str());
                            let rom_path = cmd
                                .payload
                                .get("rom_path")
                                .and_then(|v| v.as_str())
                                .and_then(|rel| {
                                    for root in &rom_roots {
                                        let full = std::path::Path::new(root).join(rel);
                                        if full.exists() {
                                            return Some(full.to_string_lossy().to_string());
                                        }
                                    }
                                    tracing::warn!(
                                        "[POLL] rom_path not found in any ROM root: {rel}"
                                    );
                                    None
                                });
                            let platform = cmd
                                .payload
                                .get("platform")
                                .and_then(|v| v.as_str());
                            let peer_tokens_json = cmd
                                .payload
                                .get("peer_tokens")
                                .and_then(|v| serde_json::to_string(v).ok());

                            tracing::info!(
                                "[POLL] start_game: {game_id}"
                            );

                            // Kill previous worker for this game_id
                            if let Some(old) = gv_web_workers.remove(game_id) {
                                tracing::info!(
                                    "[POLL] killing previous worker for {game_id}"
                                );
                                old.kill().await;
                            }

                            // Kill all workers for this host_token
                            if let Some(ht) = host_token {
                                let victims: Vec<String> = gv_web_workers
                                    .iter()
                                    .filter(|(_, w)| w.host_token() == Some(ht))
                                    .map(|(gid, _)| gid.clone())
                                    .collect();
                                for gid in &victims {
                                    if let Some(old) = gv_web_workers.remove(gid) {
                                        tracing::info!(
                                            "[POLL] killing worker for {gid} (host switched games)"
                                        );
                                        old.kill().await;
                                    }
                                }
                            }

                            match crate::worker::spawn_worker(
                                game_id,
                                state.worker_bin.as_deref(),
                                host_token,
                                rom_path.as_deref(),
                                platform,
                                peer_tokens_json.as_deref(),
                            )
                            .await
                            {
                                Ok(worker) => {
                                    let url = worker.url.clone();
                                    tracing::info!("[POLL] spawned worker at {url}");

                                    // Health check
                                    let health_url = format!("{url}/health");
                                    match client
                                        .http_client()
                                        .get(&health_url)
                                        .send()
                                        .await
                                    {
                                        Ok(resp) if resp.status().is_success() => {
                                            tracing::info!("[POLL] health check passed: {url}");
                                        }
                                        other => {
                                            tracing::warn!(
                                                "[POLL] health check failed for {url}: {:?}",
                                                other.err().map(|e| e.to_string())
                                            );
                                        }
                                    }

                                    // Share session info with local-play UI
                                    {
                                        let mut sessions = state.sessions.lock().await;
                                        sessions.insert(game_id.to_string(), url.clone());
                                    }

                                    // Notify gv-web
                                    if let Err(e) = client
                                        .notify(&cmd.id, &cmd.lease_token, &url, game_id)
                                        .await
                                    {
                                        tracing::error!(
                                            "[POLL] notify failed: {e:#}"
                                        );
                                    }

                                    gv_web_workers.insert(game_id.to_string(), worker);
                                }
                                Err(e) => {
                                    tracing::error!("[POLL] spawn failed: {e:#}");
                                }
                            }
                        }

                        "stop_game" => {
                            let game_id = cmd
                                .payload
                                .get("game_id")
                                .and_then(|v| v.as_str())
                                .unwrap_or("unknown");
                            tracing::info!("[POLL] stop_game: {game_id}");

                            if let Some(worker) = gv_web_workers.remove(game_id) {
                                worker.kill().await;
                                // Clean up shared session info
                                {
                                    let mut sessions = state.sessions.lock().await;
                                    sessions.remove(game_id);
                                }
                                {
                                    let mut counters = state.seat_counters.lock().await;
                                    counters.remove(game_id);
                                }

                                if let Err(e) = client
                                    .notify_stop(&cmd.id, &cmd.lease_token, game_id)
                                    .await
                                {
                                    tracing::error!(
                                        "[POLL] stop notify failed for {game_id}: {e:#}"
                                    );
                                }
                            } else {
                                tracing::warn!(
                                    "[POLL] stop_game for unknown game: {game_id}"
                                );
                            }
                        }

                        "sdp_offer" => {
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

                            if sdp.is_empty() {
                                tracing::warn!("[POLL] sdp_offer with empty SDP");
                                continue;
                            }

                            // Reap exited workers before relaying
                            gv_web_workers.retain(|gid, w| {
                                if w.reap_if_exited() {
                                    tracing::warn!("[POLL] worker for {gid} exited");
                                    false
                                } else {
                                    true
                                }
                            });

                            if let Some(worker) = gv_web_workers.get(game_id) {
                                let internal_url = internal_worker_url(&worker.url);
                                tracing::info!("[POLL] relaying SDP to {internal_url}");

                                let mut sdp_body = serde_json::json!({ "sdp": sdp });
                                if let Some(ht) = cmd.payload.get("host_token").and_then(|v| v.as_str()) {
                                    sdp_body["host_token"] = serde_json::Value::String(ht.to_string());
                                }
                                if let Some(pt) = cmd.payload.get("peer_token").and_then(|v| v.as_str()) {
                                    sdp_body["peer_token"] = serde_json::Value::String(pt.to_string());
                                }
                                if let Some(pr) = cmd.payload.get("peer_role").and_then(|v| v.as_str()) {
                                    sdp_body["peer_role"] = serde_json::Value::String(pr.to_string());
                                }
                                if let Some(ps) = cmd.payload.get("peer_seat") {
                                    sdp_body["peer_seat"] = ps.clone();
                                }

                                match client
                                    .http_client()
                                    .post(format!("{internal_url}/sdp"))
                                    .bearer_auth(worker.control_token())
                                    .json(&sdp_body)
                                    .send()
                                    .await
                                {
                                    Ok(resp) if resp.status().is_success() => {
                                        match resp.json::<serde_json::Value>().await {
                                            Ok(answer) => {
                                                if let Some(answer_sdp) =
                                                    answer.get("sdp").and_then(|v| v.as_str())
                                                    && let Err(e) = client
                                                        .notify_sdp(
                                                            &cmd.id, &cmd.lease_token,
                                                            &worker.url, game_id, answer_sdp,
                                                        )
                                                        .await
                                                    {
                                                        tracing::error!("[POLL] notify_sdp failed: {e:#}");
                                                    }
                                            }
                                            Err(e) => {
                                                tracing::error!("[POLL] failed to parse SDP answer: {e}");
                                                let _ = client
                                                    .command_result(&cmd.id, &cmd.lease_token, &serde_json::json!({
                                                        "error": "worker_answer_parse_failed",
                                                        "message": e.to_string()
                                                    }))
                                                    .await;
                                            }
                                        }
                                    }
                                    Ok(resp) => {
                                        let status = resp.status().as_u16();
                                        let body = resp.text().await.unwrap_or_default();
                                        tracing::error!("[POLL] worker SDP returned HTTP {status}: {body}");
                                        let _ = client
                                            .command_result(&cmd.id, &cmd.lease_token, &serde_json::json!({
                                                "error": "worker_sdp_http_error",
                                                "status": status,
                                                "message": body
                                            }))
                                            .await;
                                    }
                                    Err(e) => {
                                        tracing::error!("[POLL] SDP relay failed: {e}");
                                        let _ = client
                                            .command_result(&cmd.id, &cmd.lease_token, &serde_json::json!({
                                                "error": "worker_unreachable",
                                                "message": e.to_string()
                                            }))
                                            .await;
                                    }
                                }
                            } else {
                                tracing::warn!("[POLL] no worker for sdp_offer game {game_id}");
                                let _ = client
                                    .command_result(&cmd.id, &cmd.lease_token, &serde_json::json!({
                                        "error": "worker_not_running"
                                    }))
                                    .await;
                            }
                        }

                        "browse_files" | "scan_paths" => {
                            // TODO: implement scan commands for local+relay
                            tracing::debug!("[POLL] {} command (not yet implemented in local mode)", cmd.command_type);
                        }

                        other => {
                            tracing::debug!("[POLL] unhandled command type: {other}");
                        }
                    }
                }

                // Dead worker cleanup — also remove from shared state
                let mut dead: Vec<String> = Vec::new();
                for (game_id, worker) in gv_web_workers.iter_mut() {
                    if worker.reap_if_exited() {
                        tracing::warn!("[POLL] worker for {game_id} died");
                        dead.push(game_id.clone());
                    }
                }
                for game_id in &dead {
                    gv_web_workers.remove(game_id);
                    {
                        let mut sessions = state.sessions.lock().await;
                        sessions.remove(game_id);
                    }
                    {
                        let mut counters = state.seat_counters.lock().await;
                        counters.remove(game_id);
                    }
                    let _ = client.notify_worker_dead(game_id).await;
                }

                tokio::time::sleep(Duration::from_millis(resp.next_poll_ms)).await;
            }
            Err(e) => {
                tracing::error!("[POLL] error: {:#}", e);
                tokio::time::sleep(Duration::from_millis(POLL_ERROR_BACKOFF_MS)).await;
            }
        }
    }
}

fn internal_worker_url(public_url: &str) -> String {
    if let Some(colon) = public_url.rfind(':')
        && let Ok(port) = public_url[colon + 1..].parse::<u16>() {
            return format!("http://127.0.0.1:{port}");
        }
    public_url.to_string()
}
