//! API endpoints for the local-play server.
//!
//! `/api/games` — list discoverable ROMs from configured roots.
//! `/api/games/{id}/play` — spawn a worker and return connection details.
//! `/api/sessions` — list active game sessions.

use std::sync::Arc;

use axum::{
    Json,
    extract::{Path, Query, State},
    http::StatusCode,
};
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use rand::Rng;
use serde::{Deserialize, Serialize};

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
    /// Assigned controller seat (0 = P1 host, 1 = P2 player, …)
    pub seat: u32,
    /// Role for this peer ("host" or "player")
    pub role: String,
}

#[derive(Serialize)]
pub struct SessionEntry {
    pub game_id: String,
    pub worker_url: String,
}

#[derive(Deserialize, Default)]
pub struct SearchQuery {
    /// Filter games by name or platform (case-insensitive substring).
    pub search: Option<String>,
}

// ── Handlers ───────────────────────────────────────────────────────────

/// List all discoverable ROM files across configured ROM roots.
/// Accepts optional `?search=` query param to filter server-side.
pub async fn list_games(
    State(state): State<Arc<AppState>>,
    Query(q): Query<SearchQuery>,
) -> Json<GamesResponse> {
    let mut games = Vec::new();
    let mut warnings = Vec::new();
    let term = q.search.as_ref().map(|s| s.to_lowercase());

    for root in &state.rom_roots {
        match crate::scan::discover_roms(std::path::Path::new(root)) {
            Ok(files) => {
                for f in files {
                    let platform = f
                        .platform
                        .unwrap_or_else(|| "Unknown".into());
                    let directory = std::path::Path::new(&f.relative_path)
                        .parent()
                        .and_then(|p| p.file_name())
                        .and_then(|n| n.to_str())
                        .unwrap_or(root)
                        .to_string();

                    // Server-side search filter
                    if let Some(ref t) = term {
                        let name_lower = f.file_name.to_lowercase();
                        let plat_lower = platform.to_lowercase();
                        if !name_lower.contains(t) && !plat_lower.contains(t) {
                            continue;
                        }
                    }

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
/// worker URL (prevents duplicate spawns) with an incremented seat for
/// multi-player. First player always gets seat 0 / host; subsequent
/// players get seats 1, 2, … with role "player".
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

    // Verify file still exists (TOCTOU guard — #459)
    if !full_path.is_file() {
        return Err((
            StatusCode::NOT_FOUND,
            format!("game file disappeared: {rel_path}"),
        ));
    }

    // Generate a stable game_id from the base64-encoded relative path (#454)
    let game_id = URL_SAFE_NO_PAD.encode(rel_path.as_bytes());

    // Generate a peer token (the browser will pass this to the worker)
    let peer_token: String = rand::thread_rng()
        .sample_iter(&rand::distributions::Alphanumeric)
        .take(24)
        .map(char::from)
        .collect();

    // ── Check for existing worker ──
    {
        let sessions = state.sessions.lock().await;
        if let Some(existing_url) = sessions.get(&game_id) {
            let workers = state.workers.lock().await;
            if workers.contains_key(existing_url) {
                // Existing worker — assign next seat
                let mut counters = state.seat_counters.lock().await;
                let next = counters.entry(game_id.clone()).or_insert(1);
                let seat = *next;
                *next = seat.saturating_add(1);
                drop(counters);

                let role = if seat == 0 { "host" } else { "player" };
                tracing::info!(
                    "[LOCAL] joining existing game {rel_path} seat={seat} role={role}"
                );
                return Ok(Json(PlayResponse {
                    worker_url: existing_url.clone(),
                    peer_token,
                    seat,
                    role: role.to_string(),
                }));
            }
        }
    }

    // ── First player: spawn worker ──
    // Detect platform for core selection
    let platform = crate::platform::detect_platform_name(&full_path);

    // Convert to owned String before passing across function call (#461)
    let content_path = full_path.display().to_string();

    // Spawn the worker
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
        sessions.insert(game_id.clone(), worker_url.clone());
    }
    // First player: seed seat counter at 1 (next player gets seat 1)
    {
        let mut counters = state.seat_counters.lock().await;
        counters.entry(game_id.clone()).or_insert(1);
    }

    tracing::info!(
        "[LOCAL] spawned worker for {rel_path} at {worker_url} (platform={})",
        platform.unwrap_or_default()
    );

    Ok(Json(PlayResponse {
        worker_url,
        peer_token,
        seat: 0,
        role: "host".to_string(),
    }))
}

// ── Helpers ────────────────────────────────────────────────────────────

/// Find a file by relative path across configured ROM roots.
fn find_in_roots(rel_path: &str, roots: &[String]) -> Option<std::path::PathBuf> {
    for root in roots {
        let candidate = std::path::Path::new(root).join(rel_path);
        if let Ok(resolved) = crate::scan::resolve_within_roots(&candidate, roots)
            && resolved.is_file() {
                return Some(resolved);
            }
    }
    None
}
