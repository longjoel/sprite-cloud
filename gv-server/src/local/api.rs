//! API endpoints for the local-play server.
//!
//! `/api/games` — list discoverable ROMs from configured roots.
//! `/api/games/{id}/play` — spawn a worker and return connection details.

use std::sync::Arc;

use axum::{
    Json,
    extract::{Path, State},
    http::StatusCode,
};
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use rand::Rng;
use serde::Serialize;

use super::AppState;

// ── Types ──────────────────────────────────────────────────────────────

#[derive(Serialize)]
pub struct GameEntry {
    pub id: String,
    pub name: String,
    pub platform: String,
    pub relative_path: String,
}

#[derive(Serialize)]
pub struct PlayResponse {
    pub worker_url: String,
    pub peer_token: String,
}

// ── Handlers ───────────────────────────────────────────────────────────

/// List all discoverable ROM files across configured ROM roots.
///
/// Skips roots that don't exist or are inaccessible — a non-existent
/// root is not a fatal error for the local server.
pub async fn list_games(
    State(state): State<Arc<AppState>>,
) -> Json<Vec<GameEntry>> {
    let mut games = Vec::new();

    for root in &state.rom_roots {
        match crate::scan::discover_roms(std::path::Path::new(root)) {
            Ok(files) => {
                for f in files {
                    let platform = f
                        .platform
                        .unwrap_or_else(|| "Unknown".into());
                    games.push(GameEntry {
                        id: URL_SAFE_NO_PAD.encode(f.relative_path.as_bytes()),
                        name: f.file_name.clone(),
                        platform,
                        relative_path: f.relative_path.clone(),
                    });
                }
            }
            Err(e) => {
                tracing::warn!("[LOCAL] failed to scan root {root}: {e}");
            }
        }
    }

    // Sort by name for the browser grid
    games.sort_by(|a, b| a.name.cmp(&b.name));
    Json(games)
}

/// Spawn a gv-worker for the selected game and return connection info.
///
/// The `id` in the URL path is a base64url-encoded relative path
/// (from `GameEntry.id`). We decode it, resolve against ROM roots,
/// and spawn the worker.
pub async fn start_play(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<Json<PlayResponse>, (StatusCode, String)> {
    // Decode the base64url-encoded relative path
    let rel_path = URL_SAFE_NO_PAD
        .decode(&id)
        .map_err(|_| (StatusCode::BAD_REQUEST, "invalid game id (base64 decode failed)".into()))?;
    let rel_path = String::from_utf8(rel_path)
        .map_err(|_| (StatusCode::BAD_REQUEST, "invalid game id (not utf-8)".into()))?;

    // Find the full path within ROM roots
    let full_path = find_in_roots(&rel_path, &state.rom_roots)
        .ok_or((StatusCode::NOT_FOUND, format!("game not found: {rel_path}")))?;

    // Generate a game ID from the filename for PID file tracking
    let game_id = std::path::Path::new(&rel_path)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or(&rel_path);

    // Detect platform for core selection
    let platform = crate::platform::detect_platform_name(&full_path);

    // Generate a peer token (the browser will pass this to the worker)
    let peer_token: String = rand::thread_rng()
        .sample_iter(&rand::distributions::Alphanumeric)
        .take(24)
        .map(char::from)
        .collect();

    // Spawn the worker — reuses the existing spawn_worker function
    let worker = crate::worker::spawn_worker(
        game_id,
        state.worker_bin.as_deref(),
        None, // no host_token — local play has no auth
        Some(&full_path.to_string_lossy()),
        platform.as_deref(),
        None, // no peer_tokens_json — DC auth removed
    )
    .await
    .map_err(|e| {
        let msg = format!("failed to spawn worker: {e}");
        tracing::error!("[LOCAL] {msg}");
        (StatusCode::INTERNAL_SERVER_ERROR, msg)
    })?;

    let worker_url = worker.url.clone();

    // Store for idle cleanup
    state.workers.lock().await.insert(worker_url.clone(), worker);

    tracing::info!(
        "[LOCAL] spawned worker for {rel_path} at {worker_url} (platform={})",
        platform.unwrap_or_default()
    );

    Ok(Json(PlayResponse {
        worker_url,
        peer_token,
    }))
}

// ── Helpers ────────────────────────────────────────────────────────────

/// Find a file by relative path across configured ROM roots.
///
/// Uses `resolve_within_roots` for path traversal protection.
fn find_in_roots(rel_path: &str, roots: &[String]) -> Option<std::path::PathBuf> {
    for root in roots {
        let candidate = std::path::Path::new(root).join(rel_path);
        if let Ok(resolved) = crate::scan::resolve_within_roots(&candidate, roots) {
            if resolved.is_file() {
                return Some(resolved);
            }
        }
    }
    None
}
