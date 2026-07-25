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
use crate::saves;
use crate::sc_web;

/// Build the worker HTTP URL using GV_WORKER_HOST env var (LAN IP) or fallback.
fn worker_url(game_id: &str) -> String {
    let host = std::env::var("GV_WORKER_HOST").unwrap_or_else(|_| "localhost".into());
    let port = std::env::var("GV_WORKER_PORT").unwrap_or_else(|_| "8787".into());
    format!("http://{host}:{port}/{game_id}")
}

fn apply_pairing(
    existing: Option<config::Config>,
    sc_web_url: &str,
    api_key: String,
    server_id: String,
    rom_roots: Vec<String>,
) -> config::Config {
    let mut cfg = existing.unwrap_or(config::Config {
        sc_web: config::ScWeb {
            url: sc_web_url.to_string(),
        },
        auth: config::Auth {
            api_key: String::new(),
            server_id: String::new(),
        },
        rom: None,
        cores: None,
        ice: None,
    });
    cfg.sc_web.url = sc_web_url.to_string();
    cfg.auth.api_key = api_key;
    cfg.auth.server_id = server_id;
    if !rom_roots.is_empty() {
        cfg.rom = Some(config::Rom { roots: rom_roots });
    }
    cfg
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

    let existing = config::load().ok();
    let rom_roots = config::effective_rom_roots(existing.as_ref());

    if !rom_roots.is_empty() {
        tracing::info!("  rom_roots: {:?}", rom_roots);
    }

    let hostname = std::fs::read_to_string("/proc/sys/kernel/hostname")
        .map(|s| s.trim().to_string())
        .unwrap_or_else(|_| "unknown".to_string());

    let resp = sc_web::ScWebClient::claim(code, sc_web_url, &hostname).await?;

    let cfg = apply_pairing(
        existing,
        sc_web_url,
        resp.api_key.clone(),
        resp.server_id.clone(),
        rom_roots,
    );

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
    if let Some(cores) = cfg.cores.as_ref() {
        core_bridge::configure_cores_dir(&cores.dir);
    }
    let library_preferences = crate::player_server::open_library_preferences()
        .context("load local library preferences")?;

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

    let rom_roots = config::effective_rom_roots(Some(&cfg));

    // sc-server remains the source of truth even in relay-only mode: remote
    // start commands resolve opaque IDs locally and never need ROM paths from sc-web.
    let local_games = scan_library(&rom_roots);
    tracing::info!("Local library: {} games", local_games.len());
    let local_game_list = Arc::new(tokio::sync::RwLock::new(local_games));
    let local_rom_roots = Arc::new(rom_roots.clone());

    // Sync game catalog to sc-web so the cloud library page works
    {
        let prefs_snapshot = library_preferences.lock().await.snapshot();
        let games_snapshot = local_game_list.read().await;
        sync_catalog(&client, &games_snapshot, &prefs_snapshot).await;
    }

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
        let player_addr: SocketAddr = std::env::var("GV_PLAYER_BIND")
            .unwrap_or_else(|_| "0.0.0.0:8787".into())
            .parse()
            .unwrap_or_else(|_| SocketAddr::from(([0, 0, 0, 0], 8787)));
        tokio::spawn(crate::player_server::serve(
            player_addr,
            cfg.sc_web.url.clone(),
            cfg.auth.api_key.clone(),
            verify.server_id.clone(),
            verify.user_id.clone(),
            verify.name.clone(),
            true,
            Arc::clone(&local_game_list),
            Arc::clone(&local_rom_roots),
            Arc::clone(&library_preferences),
        ));
    } else {
        tracing::info!("LAN player disabled (--no-lan-player) — relay-only mode");
    }

    const POLL_ERROR_BACKOFF_MS: u64 = 5_000;
    let mut sessions: HashMap<String, Arc<GameSession>> = HashMap::new();

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
                                let game_id = cmd
                                    .payload
                                    .get("game_id")
                                    .and_then(|value| value.as_str());
                                tracing::info!(
                                    "[POLL] command {}: {} game_id={:?} has_host_token={} has_room_token={} has_peer_token={}",
                                    cmd.id,
                                    cmd.command_type,
                                    game_id,
                                    cmd.payload.get("host_token").is_some(),
                                    cmd.payload.get("room_token").is_some(),
                                    cmd.payload.get("peer_token").is_some(),
                                );

                                if cmd.command_type == "start_game" {
                                    game::handle_start_game(
                                        cmd, &client, &mut sessions,
                                        &rom_roots, &local_game_list, &pc_pool,
                                        &library_preferences,
                                    ).await;
                                } else if cmd.command_type == "stop_game" {
                                    game::handle_stop_game(cmd, &client, &mut sessions).await;
                                } else if cmd.command_type == "sdp_offer" {
                                    game::handle_sdp_offer(
                                        cmd, &client, &sessions, &pc_pool,
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
                            if let Some(session) = sessions.remove(gid) {
                                let _ = client
                                    .notify_worker_dead(gid, session.cloud_session_id.as_deref())
                                    .await;
                            }
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

/// Push the current game catalog to sc-web for cloud library search.
///
/// Sends only metadata (id, name, platform, max_players).
/// ROM paths and library preferences stay local.
async fn sync_catalog(
    client: &crate::sc_web::ScWebClient,
    games: &[crate::player_server::LocalGame],
    preferences: &crate::library_state::LibraryPreferences,
) {
    let entries: Vec<serde_json::Value> = games
        .iter()
        .map(|game| {
            let fallback = crate::player_server::local_game_name(game);
            let name = preferences.display_name(&game.id, &fallback);
            serde_json::json!({
                "id": game.id,
                "name": name,
                "platform": game.discovered.platform.as_deref().unwrap_or("Unknown"),
                "max_players": 1,
            })
        })
        .collect();

    if entries.is_empty() {
        tracing::info!("[SYNC] no games to sync");
        return;
    }

    if let Err(error) = client.sync_library(&entries).await {
        tracing::warn!("[SYNC] failed to push catalog to sc-web: {error:#}");
    }
}

// ── Standalone mode — no sc-web, local library only ───────────────

async fn cmd_start_standalone(no_lan_player: bool) -> Result<()> {
    if no_lan_player {
        anyhow::bail!("--standalone cannot be combined with --no-lan-player");
    }

    tracing::info!("Starting sc-server in standalone mode (no sc-web, no pairing)");

    // Standalone mode still honors setup's persisted ROM roots.
    let cfg = config::load().ok();
    if let Some(cores) = cfg.as_ref().and_then(|config| config.cores.as_ref()) {
        core_bridge::configure_cores_dir(&cores.dir);
    }
    let rom_roots = config::effective_rom_roots(cfg.as_ref());

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
    let library_preferences = crate::player_server::open_library_preferences()
        .context("load local library preferences")?;

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
    crate::player_server::serve_standalone(player_addr, game_list, rom_roots, library_preferences)
        .await;

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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pairing_preserves_setup_rom_core_and_ice_config() {
        let existing = config::Config {
            sc_web: config::ScWeb {
                url: "https://old.example".into(),
            },
            auth: config::Auth {
                api_key: String::new(),
                server_id: String::new(),
            },
            rom: Some(config::Rom {
                roots: vec!["/games/roms".into()],
            }),
            cores: Some(config::Cores {
                dir: "/games/cores".into(),
            }),
            ice: Some(config::Ice {
                stun_url: "stun:example.test:3478".into(),
                policy: "all".into(),
                turn: None,
            }),
        };

        let paired = apply_pairing(
            Some(existing),
            "https://sprite-cloud.com",
            "api-key".into(),
            "server-id".into(),
            vec!["/games/roms".into()],
        );

        assert_eq!(paired.rom.unwrap().roots, vec!["/games/roms"]);
        assert_eq!(paired.cores.unwrap().dir, "/games/cores");
        assert_eq!(paired.ice.unwrap().stun_url, "stun:example.test:3478");
        assert_eq!(paired.auth.server_id, "server-id");
    }
}
