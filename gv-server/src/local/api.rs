//! API endpoints for the local-play server.
//!
//! `/api/games` — list discoverable ROMs from configured roots.
//! `/api/games/{id}/play` — spawn a worker and return connection details.
//! `/api/sessions` — list active game sessions.

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
    /// Parent directory or ROM root name for disambiguation.
    pub directory: String,
}

#[derive(Serialize)]
pub struct GamesResponse {
    pub games: Vec<GameEntry>,
    /// Non-fatal warnings about root scan failures.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub warnings: Vec<String>,
}

#[derive(Serialize)]
pub struct PlayResponse {
    pub worker_url: String,
    pub peer_token: String,
}

#[derive(Serialize)]
pub struct SessionEntry {
    pub game_id: String,
    pub worker_url: String,
}

// ── Handlers ───────────────────────────────────────────────────────────

/// List all discoverable ROM files across configured ROM roots.
pub async fn list_games(
    State(state): State<Arc<AppState>>,
) -> Json<GamesResponse> {
    let mut games = Vec::new();
    let mut warnings = Vec::new();

    for root in &state.rom_roots {
        match crate::scan::discover_roms(std::path::Path::new(root)) {
            Ok(files) => {
                for f in files {
                    let platform = f
                        .platform
                        .unwrap_or_else(|| "Unknown".into());
                    // Determine directory for disambiguation
                    let directory = std::path::Path::new(&f.relative_path)
                        .parent()
                        .and_then(|p| p.file_name())
                        .and_then(|n| n.to_str())
                        .unwrap_or(root)
                        .to_string();
                    games.push(GameEntry {
                        id: URL_SAFE_NO_PAD.encode(f.relative_path.as_bytes()),
                        name: f.file_name.clone(),
                        platform,
                        relative_path: f.relative_path.clone(),
                        directory,
                    });
                }
            }
            Err(e) => {
                let msg = format!("failed to scan {root}: {e}");
                tracing::warn!("[LOCAL] {msg}");
                warnings.push(msg);
            }
        }
    }

    // Sort by name for the browser grid
    games.sort_by(|a, b| a.name.cmp(&b.name));
    Json(GamesResponse { games, warnings })
}

/// Return active game sessions for "currently playing" UI.
pub async fn list_sessions(
    State(state): State<Arc<AppState>>,
) -> Json<Vec<SessionEntry>> {
    let sessions = state.sessions.lock().await;
    let entries: Vec<_> = sessions
        .iter()
        .map(|(game_id, worker_url)| SessionEntry {
            game_id: game_id.clone(),
            worker_url: worker_url.clone(),
        })
        .collect();
    Json(entries)
}

/// Spawn a gv-worker for the selected game and return connection info.
///
/// If a worker for this game is already running, returns the existing
/// worker URL (prevents duplicate spawns).
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

    // Generate a stable game_id from the full path — uses base64 so
    // paths with the same filename stem get different IDs (#454).
    let game_id = URL_SAFE_NO_PAD.encode(rel_path.as_bytes());

    // Check if this game already has a running worker (#455)
    {
        let sessions = state.sessions.lock().await;
        if let Some(existing_url) = sessions.get(&game_id) {
            // Verify the worker is still alive
            let workers = state.workers.lock().await;
            if workers.contains_key(existing_url) {
                let peer_token: String = rand::thread_rng()
                    .sample_iter(&rand::distributions::Alphanumeric)
                    .take(24)
                    .map(char::from)
                    .collect();
                return Ok(Json(PlayResponse {
                    worker_url: existing_url.clone(),
                    peer_token,
                }));
            }
        }
    }

    // Detect platform for core selection
    let platform = crate::platform::detect_platform_name(&full_path);

    // Generate a peer token (the browser will pass this to the worker)
    let peer_token: String = rand::thread_rng()
        .sample_iter(&rand::distributions::Alphanumeric)
        .take(24)
        .map(char::from)
        .collect();

    // Convert to owned String before passing across function call (#461)
    let content_path = full_path.display().to_string();

    // Spawn the worker — reuses the existing spawn_worker function
    let worker = crate::worker::spawn_worker(
        &game_id,
        state.worker_bin.as_deref(),
        None,
        Some(&content_path),
        platform.as_deref(),
        None,
    )
    .await
    .map_err(|e| {
        let msg = format!("failed to spawn worker: {e}");
        tracing::error!("[LOCAL] {msg}");
        (StatusCode::INTERNAL_SERVER_ERROR, msg)
    })?;

    let worker_url = worker.url.clone();

    // Store for idle cleanup and session tracking
    {
        let mut workers = state.workers.lock().await;
        workers.insert(worker_url.clone(), worker);
    }
    {
        let mut sessions = state.sessions.lock().await;
        sessions.insert(game_id, worker_url.clone());
    }

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
