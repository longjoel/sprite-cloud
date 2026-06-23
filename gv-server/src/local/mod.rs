//! Self-contained local-play HTTP server.
//!
//! Serves a game browser UI and APIs for listing ROMs and spawning workers.
//! No pairing, no accounts, no internet required — run `gv-server local`
//! and open `http://server-ip:8090` on any LAN machine.

mod api;
mod ui;

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use axum::{Router, routing::get, routing::post};
use tokio::sync::Mutex;
use tower_http::cors::CorsLayer;

use crate::worker::SpawnedWorker;

/// Shared server state.
pub struct AppState {
    /// ROM root directories from `config.toml` `[rom]` section.
    pub rom_roots: Vec<String>,
    /// Active workers keyed by their URL. Used for idle cleanup.
    pub workers: Mutex<HashMap<String, SpawnedWorker>>,
    /// Active game sessions: game_id → worker_url.
    /// Prevents duplicate spawns and enables "currently playing" UI.
    pub sessions: Mutex<HashMap<String, String>>,
    /// Path to the gv-worker binary (from config or auto-detected).
    pub worker_bin: Option<String>,
}

/// Start the local-play HTTP server.
pub async fn serve(port: u16) -> anyhow::Result<()> {
    // Clean up orphaned workers from a previous crash.
    crate::worker::reap_stale_workers();

    let config = crate::config::load().unwrap_or_else(|_| {
        tracing::warn!("[LOCAL] no config.toml found — no ROM roots configured");
        crate::config::Config {
            gv_web: crate::config::GvWeb {
                url: "http://localhost:3001".into(),
                worker_bin: None,
            },
            auth: crate::config::Auth {
                api_key: String::new(),
                server_id: String::new(),
            },
            rom: Some(crate::config::Rom { roots: vec![] }),
        }
    });

    let rom_roots = config.rom.as_ref().map(|r| r.roots.clone()).unwrap_or_default();
    let worker_bin = config.gv_web.worker_bin.clone();

    let state = Arc::new(AppState {
        rom_roots,
        workers: Mutex::new(HashMap::new()),
        sessions: Mutex::new(HashMap::new()),
        worker_bin,
    });

    // Spawn idle worker cleanup — checks every 60s
    let state_clone = state.clone();
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(60)).await;
            let mut workers = state_clone.workers.lock().await;
            let mut sessions = state_clone.sessions.lock().await;
            workers.retain(|url, worker| {
                if worker.reap_if_exited() {
                    tracing::info!("[LOCAL] cleaned up exited worker {url}");
                    // Clean up the session entry too
                    let gid = worker.game_id().to_string();
                    sessions.remove(&gid);
                    false
                } else {
                    true
                }
            });
        }
    });

    let app = Router::new()
        .route("/", get(ui::serve_index))
        .route("/api/games", get(api::list_games))
        .route("/api/games/:id/play", post(api::start_play))
        .route("/api/sessions", get(api::list_sessions))
        .layer(CorsLayer::permissive())
        .with_state(state);

    let addr = format!("0.0.0.0:{port}");
    tracing::info!("[LOCAL] serving at http://localhost:{port}");
    if let Ok(ip) = local_ip_address::local_ip() {
        tracing::info!("[LOCAL] LAN URL: http://{ip}:{port}");
    } else {
        tracing::warn!("[LOCAL] could not detect LAN IP — use localhost or set GV_WORKER_HOST");
    }
    let listener = tokio::net::TcpListener::bind(&addr).await?;
    axum::serve(listener, app).await?;
    Ok(())
}
