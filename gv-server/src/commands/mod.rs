//! CLI subcommand implementations: `pair` and `start`.
//!
//! `start` polls gv-web via HTTP (same as before), but game sessions now
//! run in-process — no separate runtime binary, no shm IPC, no cross-process spawn.

use anyhow::{Context, Result};
use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use crate::config;
use crate::core_bridge;
use crate::dat;
use crate::gv_web;
use crate::saves;

/// Build the worker HTTP URL using GV_WORKER_HOST env var (LAN IP) or fallback.
fn worker_url(game_id: &str) -> String {
    let host = std::env::var("GV_WORKER_HOST").unwrap_or_else(|_| "localhost".into());
    let port = std::env::var("GV_WORKER_PORT").unwrap_or_else(|_| "8787".into());
    format!("http://{host}:{port}/{game_id}")
}
use crate::scan;
use crate::session::GameSession;
use crate::streaming;
use crate::webrtc;
pub(crate) use version::collect_metadata;
pub(crate) mod version;

// ── pair subcommand ─────────────────────────────────────────────────

pub(crate) async fn cmd_pair(code: &str, gv_web_url: &str) -> Result<()> {
    tracing::info!("Pairing with {} ...", gv_web_url);

    let rom_roots: Vec<String> = std::env::var("GV_ROM_ROOTS")
        .ok()
        .map(|s| {
            s.split(',')
                .map(|p| p.trim().to_string())
                .filter(|p| !p.is_empty())
                .collect()
        })
        .unwrap_or_default();

    if !rom_roots.is_empty() {
        tracing::info!("  rom_roots: {:?}", rom_roots);
    }

    let hostname = std::fs::read_to_string("/proc/sys/kernel/hostname")
        .map(|s| s.trim().to_string())
        .unwrap_or_else(|_| "unknown".to_string());

    let resp = gv_web::GvWebClient::claim(code, gv_web_url, rom_roots.clone(), &hostname).await?;

    let cfg = config::Config {
        gv_web: config::GvWeb { url: gv_web_url.to_string() },
        auth: config::Auth {
            api_key: resp.api_key.clone(),
            server_id: resp.server_id.clone(),
        },
        rom: if rom_roots.is_empty() {
            None
        } else {
            Some(config::Rom { roots: rom_roots })
        },
    };

    config::save(&cfg).context("save config")?;

    tracing::info!("Paired!");
    tracing::info!("  server_id: {}", resp.server_id);
    tracing::info!("  api_key:   {}", &resp.api_key[..8.min(resp.api_key.len())]);
    tracing::info!("  config saved");

    Ok(())
}

// ── start subcommand (HTTP polling, in-process sessions) ────────────

pub(crate) async fn cmd_start(gv_web_url: Option<String>) -> Result<()> {
    let mut cfg = config::load().context("load config (run 'gv-server pair' first)")?;

    if let Some(url) = gv_web_url {
        cfg.gv_web.url = url;
    }

    let client = gv_web::GvWebClient::new(cfg.gv_web.url.clone(), cfg.auth.clone());

    // Verify API key
    let metadata = collect_metadata(&cfg).await;
    let verify = match client.verify_with_metadata(&metadata).await {
        Ok(v) => v,
        Err(e) => {
            let msg = format!("{e:#}");
            if msg.contains("401") || msg.contains("unauthorized") {
                tracing::error!("[AUTH] API key rejected — re-pair with: gv-server pair <CODE>");
                std::process::exit(2);
            }
            return Err(e);
        }
    };
    tracing::info!(
        "Connected to gv-web as server {} (user: {})",
        verify.server_id,
        verify.user_id
    );

    // Apply any core overrides from the dashboard
    if !verify.core_overrides.is_empty() {
        crate::platform::update_core_overrides(verify.core_overrides);
    }

    // GStreamer init (only once at startup)
    gstreamer::init().expect("GStreamer init failed");
    tracing::info!("GStreamer initialized");

    // ROM roots
    let rom_roots: Vec<String> = cfg
        .rom
        .as_ref()
        .map(|r| r.roots.clone())
        .unwrap_or_default();

    // Pre-warm ICE
    webrtc::prewarm_ice_agent().await;

    // Pre-build PC pool
    let pool_size: usize = std::env::var("GV_PC_POOL_SIZE")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(2);
    let pc_pool = webrtc::PcPool::new(pool_size).await;

    tracing::info!("gv-server running — polling for commands...");

    // Start LAN player HTTP server (port 8787) for direct guest connections
    let player_addr: SocketAddr = std::env::var("GV_PLAYER_BIND")
        .unwrap_or_else(|_| "0.0.0.0:8787".into())
        .parse()
        .unwrap_or_else(|_| SocketAddr::from(([0, 0, 0, 0], 8787)));
    tokio::spawn(crate::player_server::serve(player_addr, cfg.gv_web.url.clone()));

    const POLL_ERROR_BACKOFF_MS: u64 = 5_000;
    let mut sessions: HashMap<String, Arc<GameSession>> = HashMap::new();

    let scan_lock: Arc<tokio::sync::Mutex<()>> = Arc::new(tokio::sync::Mutex::new(()));
    let dat_index: Arc<tokio::sync::RwLock<Option<dat::DatIndex>>> =
        Arc::new(tokio::sync::RwLock::new(None));

    loop {
        tokio::select! {
            _ = shutdown_signal() => {
                tracing::info!("[SHUTDOWN] stopping all sessions...");
                for (gid, s) in &sessions {
                    s.cancel.cancel();
                    tracing::info!("[SHUTDOWN] cancelled session {gid}");
                }
                break;
            }
            _ = async {
                match client.poll().await {
                    Ok(resp) => {
                        if !resp.commands.is_empty() {
                            for cmd in &resp.commands {
                                tracing::info!(
                                    "[POLL] command {}: {} {}",
                                    cmd.id,
                                    cmd.command_type,
                                    cmd.payload,
                                );

                                if cmd.command_type == "start_game" {
                                    game::handle_start_game(
                                        cmd, &client, &mut sessions,
                                        &rom_roots, &pc_pool,
                                    ).await;
                                } else if cmd.command_type == "stop_game" {
                                    game::handle_stop_game(cmd, &client, &mut sessions).await;
                                } else if cmd.command_type == "sdp_offer" {
                                    game::handle_sdp_offer(
                                        cmd, &client, &sessions, &pc_pool,
                                    ).await;
                                } else if cmd.command_type == "browse_files" {
                                    game::handle_browse_files(cmd, &client, &rom_roots).await;
                                } else if cmd.command_type == "scan_paths" {
                                    game::handle_scan_paths(
                                        cmd, &client, &rom_roots,
                                        &scan_lock, &dat_index, &cfg.auth.server_id,
                                    ).await;
                                }
                            }
                        }

                        // Dead session cleanup
                        let mut dead: Vec<String> = Vec::new();
                        for (gid, s) in sessions.iter() {
                            if s.cancel.is_cancelled() {
                                dead.push(gid.clone());
                            }
                        }
                        for gid in &dead {
                            sessions.remove(gid);
                            let _ = client.notify_worker_dead(gid, None).await;
                        }

                        tokio::time::sleep(Duration::from_millis(resp.next_poll_ms)).await;
                    }
                    Err(e) => {
                        tracing::error!("[POLL] error: {:#}", e);
                        tokio::time::sleep(Duration::from_millis(POLL_ERROR_BACKOFF_MS)).await;
                    }
                }
            } => {}
        }
    }

    for (gid, s) in &sessions {
        s.cancel.cancel();
        tracing::info!("[SHUTDOWN] cancelled session {gid}");
    }

    tracing::info!("[SHUTDOWN] done");
    Ok(())
}

mod game;
mod dc_handler;
mod save_handlers;

// ── Shutdown signal ─────────────────────────────────────────────────

#[cfg(unix)]
async fn shutdown_signal() {
    use tokio::signal::unix::{SignalKind, signal};
    let mut sigint = signal(SignalKind::interrupt()).expect("register SIGINT handler");
    let mut sigterm = signal(SignalKind::terminate()).expect("register SIGTERM handler");
    tokio::select! {
        _ = sigint.recv() => {},
        _ = sigterm.recv() => {},
    }
}

#[cfg(not(unix))]
async fn shutdown_signal() {
    tokio::signal::ctrl_c().await.expect("register Ctrl+C handler");
}
