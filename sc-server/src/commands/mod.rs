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
        system: None,
        ice: None,
        dat: None,
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
    if let Some(system) = cfg.system.as_ref() {
        core_bridge::configure_system_dir(&system.dir);
    }
    let library_preferences = crate::player_server::open_library_preferences()
        .context("load local library preferences")?;

    if let Some(url) = sc_web_url {
        cfg.sc_web.url = url;
    }

    let client = sc_web::ScWebClient::new(cfg.sc_web.url.clone(), cfg.auth.clone());

    // DAT catalog: loaded at startup; SIGHUP reloads it atomically (a failed
    // replacement keeps the last known-good index).
    let dat_catalog_state: Arc<
        tokio::sync::RwLock<Option<Arc<crate::dat::catalog::LoadedCatalog>>>,
    > = Arc::new(tokio::sync::RwLock::new(
        crate::dat::catalog::load_from_config(&cfg),
    ));

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
        if let Err(error) = sync_catalog(&client, &games_snapshot, &prefs_snapshot).await {
            tracing::warn!("[SYNC] initial catalog push failed: {error:#}");
        }
    }
    let catalog_sync_lock = Arc::new(tokio::sync::Mutex::new(()));

    // Pre-warm ICE
    webrtc::prewarm_ice_agent().await;

    // Pre-build PC pool
    let pool_size: usize = std::env::var("GV_PC_POOL_SIZE")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(2);
    let pc_pool = webrtc::PcPool::new(pool_size).await;

    tracing::info!("sc-server running — polling for commands...");

    // Keep the task handle so process shutdown cannot preempt a local player's
    // final SRAM capture after the HTTP server begins graceful shutdown.
    let player_handle = if !no_lan_player {
        let player_addr: SocketAddr = std::env::var("GV_PLAYER_BIND")
            .unwrap_or_else(|_| "0.0.0.0:8787".into())
            .parse()
            .unwrap_or_else(|_| SocketAddr::from(([0, 0, 0, 0], 8787)));
        Some(tokio::spawn(crate::player_server::serve(
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
        )))
    } else {
        tracing::info!("LAN player disabled (--no-lan-player) — relay-only mode");
        None
    };

    const POLL_ERROR_BACKOFF_MS: u64 = 5_000;
    let mut sessions: HashMap<String, Arc<GameSession>> = HashMap::new();

    // SIGHUP → re-read config and atomically replace the DAT catalog index.
    // Any rejected catalog file keeps the last known-good index in place.
    {
        let dat_catalog_state = Arc::clone(&dat_catalog_state);
        tokio::spawn(async move {
            let mut hangup =
                match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::hangup()) {
                    Ok(signal) => signal,
                    Err(error) => {
                        tracing::warn!("[DAT] SIGHUP reload unavailable: {error}");
                        return;
                    }
                };
            loop {
                hangup.recv().await;
                tracing::info!("[DAT] reload requested (SIGHUP)");
                // Config read + XML parsing are synchronous; up to 256 × 64 MiB
                // of parsing must not stall a tokio worker thread, so the whole
                // reload runs in spawn_blocking.
                let (gathered, loaded) = match tokio::task::spawn_blocking(|| {
                    let cfg = config::load()?;
                    let gathered = crate::dat::catalog::configured_paths(&cfg);
                    let loaded = crate::dat::catalog::load_catalog(&gathered.paths);
                    Ok::<_, anyhow::Error>((gathered, loaded))
                })
                .await
                {
                    Ok(Ok(pair)) => pair,
                    Ok(Err(error)) => {
                        tracing::warn!(
                            "[DAT] reload rejected — config unreadable, keeping last known-good: {error}"
                        );
                        continue;
                    }
                    Err(join_error) => {
                        tracing::warn!(
                            "[DAT] reload task panicked — keeping last known-good: {join_error}"
                        );
                        continue;
                    }
                };
                let mut failures = gathered.failures;
                failures.extend(loaded.failures);
                if !failures.is_empty() {
                    for (name, reason) in &failures {
                        tracing::warn!(
                            "[DAT] reload rejected — keeping last known-good: {name}: {reason}"
                        );
                    }
                    continue;
                }
                match loaded.catalog {
                    Some(catalog) => {
                        tracing::info!(
                            "[DAT] reload complete — {} catalog(s), {} entries",
                            catalog.sources.len(),
                            catalog.index.len(),
                        );
                        *dat_catalog_state.write().await = Some(Arc::new(catalog));
                    }
                    None => {
                        // A reload that yields no catalogs while one was live is
                        // usually a config edit that dropped the [dat] section —
                        // call it out instead of silently disabling verification.
                        if dat_catalog_state.read().await.is_some() {
                            tracing::warn!(
                                "[DAT] reload complete — no catalogs configured; previous index dropped"
                            );
                        } else {
                            tracing::info!("[DAT] reload complete — no catalogs configured");
                        }
                        *dat_catalog_state.write().await = None;
                    }
                }
            }
        });
    }

    loop {
        tokio::select! {
            _ = shutdown_signal() => {
                tracing::info!("[SHUTDOWN] stopping all sessions...");
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
                                } else if cmd.command_type == "rom_transfer" {
                                    crate::rom_transfer::session::handle_rom_transfer(
                                        cmd,
                                        &client,
                                        &rom_roots,
                                        Arc::clone(&local_game_list),
                                        Arc::clone(&library_preferences),
                                        Arc::clone(&catalog_sync_lock),
                                    ).await;
                                } else if cmd.command_type == "delete_game" {
                                    handle_delete_game(
                                        cmd,
                                        &client,
                                        &rom_roots,
                                        &sessions,
                                        Arc::clone(&local_game_list),
                                        Arc::clone(&library_preferences),
                                        Arc::clone(&catalog_sync_lock),
                                    ).await;
                                } else if cmd.command_type == "rom_download" {
                                    crate::rom_transfer::download::handle_rom_download(
                                        cmd,
                                        &client,
                                        &rom_roots,
                                        Arc::clone(&local_game_list),
                                    ).await;
                                } else if cmd.command_type == "stage_rom" {
                                    // Clone the Arc (cheap) so the catalog stays
                                    // alive across the await without holding the
                                    // lock guard.
                                    let catalog = dat_catalog_state.read().await.clone();
                                    crate::commands::stage_rom::handle_stage_rom(
                                        cmd,
                                        &client,
                                        catalog.as_deref(),
                                    ).await;
                                } else if cmd.command_type == "upgrade_server" {
                                    if !sessions.is_empty() {
                                        if let Err(error) = client.command_result(&cmd.id, &cmd.lease_token, &serde_json::json!({
                                            "ok": false,
                                            "error": "cannot update while a game session is active",
                                        })).await {
                                            tracing::error!("[UPGRADE] failed to report active-session rejection: {error:#}");
                                        }
                                    } else {
                                        match crate::upgrade::verify_managed_restart() {
                                            Err(error) => {
                                                tracing::error!("[UPGRADE] restart preflight failed: {error:#}");
                                                if let Err(report_error) = client.command_result(&cmd.id, &cmd.lease_token, &serde_json::json!({
                                                    "ok": false,
                                                    "error": format!("restart preflight failed: {error:#}"),
                                                })).await {
                                                    tracing::error!("[UPGRADE] failed to report restart preflight failure: {report_error:#}");
                                                }
                                            }
                                            Ok(restart) => match crate::upgrade::run().await {
                                                Ok(()) => {
                                                    let result = serde_json::json!({
                                                        "ok": true,
                                                        "updated": ["sc-server", "sc-core"],
                                                        "restarting": true,
                                                    });
                                                    match client.command_result(&cmd.id, &cmd.lease_token, &result).await {
                                                        Ok(()) => restart.schedule(),
                                                        Err(error) => tracing::error!(
                                                            "[UPGRADE] binaries installed, but completion was not acknowledged; refusing restart: {error:#}"
                                                        ),
                                                    }
                                                }
                                                Err(error) => {
                                                    tracing::error!("[UPGRADE] failed: {error:#}");
                                                    if let Err(report_error) = client.command_result(&cmd.id, &cmd.lease_token, &serde_json::json!({
                                                        "ok": false,
                                                        "error": format!("{error:#}"),
                                                    })).await {
                                                        tracing::error!("[UPGRADE] failed to report update failure: {report_error:#}");
                                                    }
                                                }
                                            },
                                        }
                                    }
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

    if let Some(player_handle) = player_handle
        && let Err(error) = player_handle.await
    {
        tracing::error!("[SHUTDOWN] LAN player task failed: {error}");
    }

    if !crate::core_bridge::shutdown_all_core_bridges(Duration::from_secs(2)).await {
        tracing::error!("[SHUTDOWN] timed out waiting for core bridge shutdown");
    }

    tracing::info!("[SHUTDOWN] done");
    Ok(())
}

// ── Local library ownership ─────────────────────────────────────────

pub(crate) fn scan_library(rom_roots: &[String]) -> Vec<crate::player_server::LocalGame> {
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

/// Delete a game by opaque game ID.  Only succeeds when:
/// - The game exists and resolves under a configured ROM root.
/// - No active session is playing it.
/// - The file is a regular file (not symlink/device).
async fn handle_delete_game(
    cmd: &sc_web::Command,
    client: &sc_web::ScWebClient,
    rom_roots: &[String],
    sessions: &HashMap<String, Arc<GameSession>>,
    local_game_list: Arc<tokio::sync::RwLock<Vec<crate::player_server::LocalGame>>>,
    library_preferences: crate::player_server::SharedLibraryState,
    catalog_sync_lock: Arc<tokio::sync::Mutex<()>>,
) {
    let game_id = match cmd.payload.get("game_id").and_then(|v| v.as_str()) {
        Some(id) => id.to_string(),
        None => {
            let _ = client
                .command_result(
                    &cmd.id,
                    &cmd.lease_token,
                    &serde_json::json!({"ok": false, "error": "missing game_id"}),
                )
                .await;
            return;
        }
    };

    // ── Check active sessions ────────────────────────────────────────
    let active = sessions
        .values()
        .any(|s| s.game_id == game_id && !s.cancel.is_cancelled());
    if active {
        let _ = client
            .command_result(
                &cmd.id,
                &cmd.lease_token,
                &serde_json::json!({"ok": false, "error": "game is currently active"}),
            )
            .await;
        return;
    }

    // ── Resolve and verify ────────────────────────────────────────────
    let games = local_game_list.read().await;
    let resolved = match crate::rom_transfer::storage::resolve_download(
        &game_id,
        rom_roots,
        &games,
    ) {
        Ok(r) => r,
        Err(e) => {
            let _ = client
                .command_result(
                    &cmd.id,
                    &cmd.lease_token,
                    &serde_json::json!({"ok": false, "error": format!("{e:#}")}),
                )
                .await;
            return;
        }
    };
    let path = resolved.path;
    drop(games); // release read lock before taking write lock

    // ── Delete the file ──────────────────────────────────────────────
    if let Err(e) = std::fs::remove_file(&path) {
        tracing::error!("[DELETE] failed to remove file: {e}");
        let _ = client
            .command_result(
                &cmd.id,
                &cmd.lease_token,
                &serde_json::json!({"ok": false, "error": format!("cannot delete: {e}")}),
            )
            .await;
        return;
    }

    tracing::info!("[DELETE] game_id={game_id} removed");

    // ── Rescan and sync ─────────────────────────────────────────────
    let _guard = catalog_sync_lock.lock().await;
    let scanned = scan_library(rom_roots);
    {
        let mut current = local_game_list.write().await;
        *current = scanned;
    }
    let games_snapshot = local_game_list.read().await.clone();
    let prefs_snapshot = library_preferences.lock().await.snapshot();
    if let Err(e) =
        sync_catalog(client, &games_snapshot, &prefs_snapshot).await
    {
        tracing::error!("[DELETE] catalog sync after deletion failed: {e:#}");
        let _ = client
            .command_result(
                &cmd.id,
                &cmd.lease_token,
                &serde_json::json!({"ok": true, "warning": "deleted but catalog sync failed"}),
            )
            .await;
        return;
    }

    let _ = client
        .command_result(
            &cmd.id,
            &cmd.lease_token,
            &serde_json::json!({"ok": true, "deleted": game_id}),
        )
        .await;
}

/// Push the current game catalog to sc-web for cloud library search.
///
/// Sends only metadata (id, name, platform, max_players).
/// ROM paths and library preferences stay local.
pub(crate) async fn sync_catalog(
    client: &crate::sc_web::ScWebClient,
    games: &[crate::player_server::LocalGame],
    preferences: &crate::library_state::LibraryPreferences,
) -> Result<()> {
    let entries: Vec<serde_json::Value> = games
        .iter()
        .map(|game| {
            let fallback = crate::player_server::local_game_name(game);
            let name = preferences.display_name(&game.id, &fallback);
            serde_json::json!({
                "id": game.id,
                "name": name,
                "source_name": fallback,
                "platform": game.discovered.platform.as_deref().unwrap_or("Unknown"),
                "max_players": 4,
            })
        })
        .collect();

    client
        .sync_library(&entries)
        .await
        .context("push catalog to sc-web")?;
    Ok(())
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
    if let Some(system) = cfg.as_ref().and_then(|config| config.system.as_ref()) {
        core_bridge::configure_system_dir(&system.dir);
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
mod stage_rom;

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
    fn daemon_shutdown_keeps_player_join_and_registry_wait_wired() {
        let source = include_str!("mod.rs");
        let player_wait = ["player_handle", ".await"].concat();
        let registry_wait = ["shutdown_all_core_", "bridges(Duration::from_secs(2))"].concat();
        let player_pos = source
            .rfind(&player_wait)
            .expect("daemon shutdown must await the LAN player task");
        let registry_pos = source
            .rfind(&registry_wait)
            .expect("daemon shutdown must await all registered core bridges");
        assert!(
            player_pos < registry_pos,
            "player handlers must drain before the final core registry wait"
        );
    }

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
            system: None,
            ice: Some(config::Ice {
                stun_url: "stun:example.test:3478".into(),
                policy: "all".into(),
                turn: None,
            }),
            dat: None,
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
