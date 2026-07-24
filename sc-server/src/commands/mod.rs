//! CLI subcommand implementations: `pair` and `start`.
//!
//! `start` polls sc-web via HTTP (same as before), but game sessions now
//! run in-process — no separate runtime binary, no shm IPC, no cross-process spawn.

use anyhow::{Context, Result};
use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use crate::config;
use crate::core_bridge;
use crate::dat;
use crate::saves;
use crate::sc_web;

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

pub(crate) async fn cmd_pair(code: &str, sc_web_url: &str) -> Result<()> {
    tracing::info!("Pairing with {} ...", sc_web_url);

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

    let resp = sc_web::ScWebClient::claim(code, sc_web_url, rom_roots.clone(), &hostname).await?;

    let cfg = config::Config {
        sc_web: config::ScWeb {
            url: sc_web_url.to_string(),
        },
        auth: config::Auth {
            api_key: resp.api_key.clone(),
            server_id: resp.server_id.clone(),
        },
        rom: if rom_roots.is_empty() {
            None
        } else {
            Some(config::Rom { roots: rom_roots })
        },
        cores: None,
        ice: None,
    };

    config::save(&cfg).context("save config")?;

    tracing::info!("Paired!");
    tracing::info!("  server_id: {}", resp.server_id);
    tracing::info!(
        "  api_key:   {}",
        &resp.api_key[..8.min(resp.api_key.len())]
    );
    tracing::info!("  config saved");

    Ok(())
}

// ── start subcommand (HTTP polling, in-process sessions) ────────────

pub(crate) async fn cmd_start(
    sc_web_url: Option<String>,
    no_lan_player: bool,
    standalone: bool,
) -> Result<()> {
    // ── Standalone mode — no sc-web, no pairing, local library only ──
    if standalone {
        return cmd_start_standalone(no_lan_player).await;
    }

    let mut cfg = config::load().context("load config (run 'sc-server pair' first)")?;

    if let Some(url) = sc_web_url {
        cfg.sc_web.url = url;
    }

    let client = sc_web::ScWebClient::new(cfg.sc_web.url.clone(), cfg.auth.clone());

    let ice_runtime = config::runtime_ice_config();
    let ice_log = ice_runtime.startup_log_fields();
    tracing::info!(
        status = %ice_log.status,
        transport_policy = %ice_log.transport_policy,
        stun_url_count = ice_log.stun_url_count,
        turn_url_count = ice_log.turn_url_count,
        turn_username_present = ice_log.turn_username_present,
        turn_credential_present = ice_log.turn_credential_present,
        defaulted_to_public_stun = ice_log.defaulted_to_public_stun,
        "[ICE] effective runtime config"
    );
    if ice_runtime.status == config::IceRuntimeStatus::TurnPartialInvalid {
        tracing::warn!(
            turn_url_count = ice_log.turn_url_count,
            turn_username_present = ice_log.turn_username_present,
            turn_credential_present = ice_log.turn_credential_present,
            "[ICE] TURN URLs are configured but auth is incomplete — relay will not be usable"
        );
    }

    // Verify API key
    let metadata = collect_metadata(&cfg, !no_lan_player).await;
    let verify = match client.verify_with_metadata(&metadata).await {
        Ok(v) => v,
        Err(e) => {
            let msg = format!("{e:#}");
            if msg.contains("401") || msg.contains("unauthorized") {
                tracing::error!("[AUTH] API key rejected — re-pair with: sc-server pair <CODE>");
                std::process::exit(2);
            }
            return Err(e);
        }
    };
    tracing::info!(
        "Connected to sc-web as server {} (user: {})",
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

    // ROM roots — config first, then env var fallback
    let rom_roots: Vec<String> = cfg
        .rom
        .as_ref()
        .map(|r| r.roots.clone())
        .filter(|roots| !roots.is_empty())
        .unwrap_or_else(|| {
            std::env::var("GV_ROM_ROOTS")
                .ok()
                .map(|s| {
                    s.split(',')
                        .map(|p| p.trim().to_string())
                        .filter(|p| !p.is_empty())
                        .collect()
                })
                .unwrap_or_default()
        });

    // Pre-warm ICE
    webrtc::prewarm_ice_agent().await;

    // Pre-build PC pool
    let pool_size: usize = std::env::var("GV_PC_POOL_SIZE")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(2);
    let pc_pool = webrtc::PcPool::new(pool_size).await;

    tracing::info!("sc-server running — polling for commands...");

    // Start LAN player HTTP server (port 8787) for direct guest connections
    if !no_lan_player {
        // sc-server owns the paired LAN library. Scan only when the local
        // HTTP player is enabled so relay-only mode avoids unnecessary I/O.
        let local_games = scan_library(&rom_roots);
        tracing::info!("Local library: {} games", local_games.len());
        let local_game_list = Arc::new(tokio::sync::RwLock::new(local_games));
        let local_rom_roots = Arc::new(rom_roots.clone());

        let player_addr: SocketAddr = std::env::var("GV_PLAYER_BIND")
            .unwrap_or_else(|_| "0.0.0.0:8787".into())
            .parse()
            .unwrap_or_else(|_| SocketAddr::from(([0, 0, 0, 0], 8787)));
        tokio::spawn(crate::player_server::serve(
            player_addr,
            cfg.sc_web.url.clone(),
            verify.server_id.clone(),
            verify.user_id.clone(),
            verify.name.clone(),
            true,
            Arc::clone(&local_game_list),
            Arc::clone(&local_rom_roots),
        ));
    } else {
        tracing::info!("LAN player disabled (--no-lan-player) — relay-only mode");
    }

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
                                    let cmd = cmd.clone();
                                    let client = client.clone();
                                    let rom_roots = rom_roots.clone();
                                    let scan_lock = Arc::clone(&scan_lock);
                                    let dat_index = Arc::clone(&dat_index);
                                    let server_id = cfg.auth.server_id.clone();
                                    tokio::spawn(async move {
                                        game::handle_scan_paths(
                                            &cmd, &client, &rom_roots,
                                            &scan_lock, &dat_index, &server_id,
                                        ).await;
                                    });
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

// ── Local library ownership ─────────────────────────────────────────

fn scan_library(rom_roots: &[String]) -> Vec<crate::player_server::LocalGame> {
    let mut all_games = Vec::new();
    for root in rom_roots {
        let path = std::path::Path::new(root);
        if !path.is_dir() {
            tracing::warn!("ROM root not found, skipping: {root}");
            continue;
        }
        match scan::discover_roms(path) {
            Ok(files) => {
                tracing::info!("  {} — {} files", root, files.len());
                all_games.extend(
                    files
                        .into_iter()
                        .map(|file| crate::player_server::LocalGame::new(root, file)),
                );
            }
            Err(error) => tracing::warn!("Scan failed for {root}: {error:#}"),
        }
    }
    all_games
}

// ── Standalone mode — no sc-web, local library only ───────────────

async fn cmd_start_standalone(no_lan_player: bool) -> Result<()> {
    if no_lan_player {
        anyhow::bail!("--standalone cannot be combined with --no-lan-player");
    }

    tracing::info!("Starting sc-server in standalone mode (no sc-web, no pairing)");

    // ROM roots from env var only (no config file in standalone mode)
    let rom_roots: Vec<String> = std::env::var("GV_ROM_ROOTS")
        .ok()
        .map(|s| {
            s.split(',')
                .map(|p| p.trim().to_string())
                .filter(|p| !p.is_empty())
                .collect()
        })
        .unwrap_or_default();

    if rom_roots.is_empty() {
        // Try common default paths
        let candidates = [
            "~/roms",
            "~/ROMs",
            "~/games",
            "~/retro",
            "/home/pi/roms",
            "/home/user/roms",
        ];
        for c in &candidates {
            let expanded = shellexpand::tilde(c).to_string();
            if std::path::Path::new(&expanded).is_dir() {
                tracing::info!("Auto-detected ROM root: {expanded}");
                // We'll use this as the single root
                let roots = vec![expanded];
                return run_standalone_server(roots).await;
            }
        }
        anyhow::bail!("No ROM roots found. Set GV_ROM_ROOTS=/path/to/roms or place ROMs in ~/roms");
    }

    run_standalone_server(rom_roots).await
}

async fn run_standalone_server(rom_roots: Vec<String>) -> Result<()> {
    tracing::info!("ROM roots: {:?}", rom_roots);

    gstreamer::init().context("initialize GStreamer")?;
    tracing::info!("GStreamer initialized");
    webrtc::prewarm_ice_agent().await;

    let all_files = scan_library(&rom_roots);
    tracing::info!("Total: {} games discovered", all_files.len());
    let game_list = Arc::new(tokio::sync::RwLock::new(all_files));
    let rom_roots = Arc::new(rom_roots);

    // Start LAN player with local API routes
    let player_addr: SocketAddr = std::env::var("GV_PLAYER_BIND")
        .unwrap_or_else(|_| "0.0.0.0:8787".into())
        .parse()
        .unwrap_or_else(|_| SocketAddr::from(([0, 0, 0, 0], 8787)));
    tracing::info!(
        "Standalone server listening on http://{player_addr} — open this in your browser"
    );
    crate::player_server::serve_standalone(player_addr, game_list, rom_roots).await;

    Ok(())
}

pub(crate) mod dc_handler;
mod game;
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
    tokio::signal::ctrl_c()
        .await
        .expect("register Ctrl+C handler");
}
