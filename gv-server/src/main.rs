mod config;
mod dat;
mod gv_web;
mod retry;
mod scan;
mod worker;

use anyhow::{Context, Result};
use clap::{Parser, Subcommand};
use std::collections::HashMap;
use std::time::Duration;
use worker::SpawnedWorker;

// ── CLI ───────────────────────────────────────────────────────────────

#[derive(Parser)]
#[command(name = "gv-server", about = "Games Vault server")]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Pair with gv-web using a one-time code
    Pair {
        /// Pairing code from the gv-web dashboard (e.g. MKQZ-APLE)
        code: String,
        /// gv-web base URL (default: http://localhost:3001)
        #[arg(long, default_value = "http://localhost:3001")]
        gv_web_url: String,
    },
    /// Start the server (polls gv-web for game commands)
    Start {
        /// gv-web base URL override (uses config value by default)
        #[arg(long)]
        gv_web_url: Option<String>,
    },
}

// ── Entry point ───────────────────────────────────────────────────────

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .json()
        .with_target(false)
        .with_timer(tracing_subscriber::fmt::time::UtcTime::rfc_3339())
        .init();

    // Root span attaches a `service` field to every log line.
    let _root = tracing::info_span!("", service = "gv-server").entered();

    let cli = Cli::parse();

    match cli.command {
        Command::Pair { code, gv_web_url } => cmd_pair(&code, &gv_web_url).await,
        Command::Start { gv_web_url } => cmd_start(gv_web_url).await,
    }
}

// ── pair subcommand ───────────────────────────────────────────────────

async fn cmd_pair(code: &str, gv_web_url: &str) -> Result<()> {
    tracing::info!("Pairing with {} ...", gv_web_url);

    // Collect ROM root paths from env var or existing config.
    // GV_ROM_ROOTS is a comma-separated list of directories.
    let rom_roots: Vec<String> = std::env::var("GV_ROM_ROOTS")
        .ok()
        .map(|s| s.split(',').map(|p| p.trim().to_string()).filter(|p| !p.is_empty()).collect())
        .unwrap_or_default();

    if !rom_roots.is_empty() {
        tracing::info!("  rom_roots: {:?}", rom_roots);
    }

    let resp = gv_web::GvWebClient::claim(code, gv_web_url, rom_roots.clone()).await?;

    let cfg = config::Config {
        gv_web: config::GvWeb {
            url: gv_web_url.to_string(),
            // Persist the GV_WORKER_BIN env var if set at pairing time
            worker_bin: std::env::var("GV_WORKER_BIN").ok(),
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

// ── start subcommand ──────────────────────────────────────────────────

async fn cmd_start(gv_web_url: Option<String>) -> Result<()> {
    let mut cfg = config::load().context("load config (run 'gv-server pair' first)")?;

    if let Some(url) = gv_web_url {
        cfg.gv_web.url = url;
    }

    let client = gv_web::GvWebClient::new(cfg.gv_web.url.clone(), cfg.auth.clone());

    // Extract optional worker_bin override before cfg is consumed
    let worker_bin = cfg.gv_web.worker_bin.clone();

    // Verify the API key is still valid
    let verify = client.verify().await?;
    tracing::info!(
        "Connected to gv-web as server {} (user: {})",
        verify.server_id, verify.user_id
    );

    tracing::info!("gv-server running — polling for commands...");

    // Kill any workers orphaned by a previous crash
    worker::reap_stale_workers();

    const POLL_ERROR_BACKOFF_MS: u64 = 5_000;

    // Track spawned workers so we can kill them on shutdown.
    // Key is the game_id from the start_game command.
    let mut workers: HashMap<String, SpawnedWorker> = HashMap::new();

    // Scan serialization — one concurrent scan per server
    let scan_lock: std::sync::Arc<tokio::sync::Mutex<()>> =
        std::sync::Arc::new(tokio::sync::Mutex::new(()));

    // DAT index — loaded lazily on first scan
    let dat_index: std::sync::Arc<tokio::sync::RwLock<Option<dat::DatIndex>>> =
        std::sync::Arc::new(tokio::sync::RwLock::new(None));

    // ROM roots — configured via GV_ROM_ROOTS env var or config.toml
    let rom_roots: Vec<String> = cfg
        .rom
        .as_ref()
        .map(|r| r.roots.clone())
        .unwrap_or_default();

    loop {
        tokio::select! {
            _ = shutdown_signal() => {
                tracing::info!("[SHUTDOWN] received signal, stopping workers...");
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
                                        .and_then(|v| v.as_str());
                                    let platform = cmd
                                        .payload
                                        .get("platform")
                                        .and_then(|v| v.as_str());
                                    tracing::info!(
                                        "[POLL] start_game command {} (game: {})",
                                        cmd.id, game_id
                                    );

                                    match worker::spawn_worker(game_id, worker_bin.as_deref(), host_token, rom_path, platform).await {
                                        Ok(worker) => {
                                            let url = worker.url.clone();
                                            tracing::info!("[WORKER] spawned at {url}");

                                            // Probe health before notifying gv-web
                                            let health_url = format!("{url}/health");
                                            match client
                                                .http_client()
                                                .get(&health_url)
                                                .send()
                                                .await
                                            {
                                                Ok(resp) if resp.status().is_success() => {
                                                    tracing::info!("[WORKER] health check passed for {url}");
                                                }
                                                other => {
                                                    tracing::warn!(
                                                        "[WORKER] health check failed for {url}: {:?}",
                                                        other.err().map(|e| e.to_string())
                                                    );
                                                }
                                            }

                                            // Notify gv-web
                                            if let Err(e) = client
                                                .notify(&cmd.id, &url, game_id)
                                                .await
                                            {
                                                tracing::error!(
                                                    "[NOTIFY] failed after retries — worker is at {url}\n\
                                                     [NOTIFY]     connect manually or retry from /dev\n\
                                                     [NOTIFY]     error: {e:#}"
                                                );
                                            }

                                            workers.insert(game_id.to_string(), worker);
                                        }
                                        Err(e) => tracing::error!("[WORKER] spawn failed: {e:#}"),
                                    }
                                } else if cmd.command_type == "stop_game" {
                                    let game_id = cmd
                                        .payload
                                        .get("game_id")
                                        .and_then(|v| v.as_str())
                                        .unwrap_or("unknown");
                                    tracing::info!(
                                        "[POLL] stop_game command {} (game: {})",
                                        cmd.id, game_id
                                    );

                                    if let Some(worker) = workers.remove(game_id) {
                                        tracing::info!(
                                            "[WORKER] stopping worker for game {game_id}"
                                        );
                                        worker.kill().await;
                                        if let Err(e) = client
                                            .notify_stop(&cmd.id, game_id)
                                            .await
                                        {
                                            tracing::error!(
                                                "[NOTIFY] stop notification failed for game {game_id}: {e:#}"
                                            );
                                        }
                                    } else {
                                        tracing::warn!(
                                            "[WORKER] stop_game for unknown game {game_id} — ignoring"
                                        );
                                    }
                                } else if cmd.command_type == "sdp_offer" {
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
                                        tracing::warn!("[SDP] sdp_offer with empty SDP — ignoring");
                                        continue;
                                    }

                                    tracing::info!(
                                        "[SDP] relay offer for game {game_id} ({} chars)",
                                        sdp.len()
                                    );

                                    // Find the worker for this game and relay the SDP
                                    if let Some(worker) = workers.get(game_id) {
                                        let internal_url =
                                            internal_worker_url(&worker.url);
                                        tracing::info!(
                                            "[SDP] forwarding to worker at {internal_url}"
                                        );

                                        match client
                                            .http_client()
                                            .post(format!("{internal_url}/sdp"))
                                            .json(&serde_json::json!({ "sdp": sdp }))
                                            .send()
                                            .await
                                        {
                                            Ok(resp) if resp.status().is_success() => {
                                                match resp.json::<serde_json::Value>().await {
                                                    Ok(answer) => {
                                                        if let Some(answer_sdp) =
                                                            answer.get("sdp").and_then(|v| v.as_str())
                                                        {
                                                            tracing::info!(
                                                                "[SDP] got answer from worker ({} chars)",
                                                                answer_sdp.len()
                                                            );
                                                            if let Err(e) = client
                                                                .notify_sdp(
                                                                    &cmd.id,
                                                                    &worker.url,
                                                                    game_id,
                                                                    answer_sdp,
                                                                )
                                                                .await
                                                            {
                                                                tracing::error!(
                                                                    "[SDP] notify_sdp failed: {e:#}"
                                                                );
                                                            }
                                                        } else {
                                                            tracing::error!(
                                                                "[SDP] worker response missing 'sdp' field"
                                                            );
                                                        }
                                                    }
                                                    Err(e) => {
                                                        tracing::error!(
                                                            "[SDP] failed to parse worker answer: {e}"
                                                        );
                                                    }
                                                }
                                            }
                                            Ok(resp) => {
                                                let status = resp.status();
                                                let body = resp.text().await.unwrap_or_default();
                                                tracing::error!(
                                                    "[SDP] worker returned HTTP {}: {}",
                                                    status.as_u16(),
                                                    body
                                                );
                                            }
                                            Err(e) => {
                                                tracing::error!(
                                                    "[SDP] failed to reach worker at {internal_url}: {e}"
                                                );
                                            }
                                        }
                                    } else {
                                        tracing::warn!(
                                            "[SDP] no worker running for game {game_id} — ignoring sdp_offer"
                                        );
                                    }
                                } else if cmd.command_type == "browse_files" {
                                    let path = cmd
                                        .payload
                                        .get("path")
                                        .and_then(|v| v.as_str())
                                        .unwrap_or("");

                                    let tree = match scan::resolve_within_roots(
                                        std::path::Path::new(path),
                                        &rom_roots,
                                    ) {
                                        Ok(resolved) => scan::browse_path(&resolved),
                                        Err(e) => {
                                            tracing::warn!("[BROWSE] path rejected: {e:#}");
                                            scan::TreeNode {
                                                name: format!("Error: {e}"),
                                                node_type: "error".into(),
                                                children: vec![],
                                            }
                                        }
                                    };

                                    let result = serde_json::json!({ "tree": tree });
                                    if let Err(e) = client
                                        .command_result(&cmd.id, &result)
                                        .await
                                    {
                                        tracing::error!(
                                            "[BROWSE] failed to report result: {e:#}"
                                        );
                                    }
                                } else if cmd.command_type == "scan_paths" {
                                    let paths: Vec<String> = cmd
                                        .payload
                                        .get("paths")
                                        .and_then(|v| v.as_array())
                                        .map(|arr| {
                                            arr.iter()
                                                .filter_map(|v| {
                                                    v.as_str().map(String::from)
                                                })
                                                .collect()
                                        })
                                        .unwrap_or_default();

                                    // DoS guard — one scan at a time
                                    if scan_lock.try_lock().is_err() {
                                        tracing::warn!(
                                            "[SCAN] rejected — scan already in progress"
                                        );
                                        let result = serde_json::json!({
                                            "error": "A scan is already in progress."
                                        });
                                        let _ = client
                                            .command_result(&cmd.id, &result)
                                            .await;
                                        continue;
                                    }

                                    // Lock held until this block exits (dropped
                                    // after result is reported).
                                    let _guard = scan_lock.lock().await;

                                    let mut all_files = Vec::new();
                                    for p in &paths {
                                        let resolved = match scan::resolve_within_roots(
                                            std::path::Path::new(p),
                                            &rom_roots,
                                        ) {
                                            Ok(r) => r,
                                            Err(e) => {
                                                tracing::warn!(
                                                    "[SCAN] path rejected: {e:#}"
                                                );
                                                continue;
                                            }
                                        };

                                        let mut files =
                                            scan::discover_roms(&resolved)
                                                .unwrap_or_default();
                                        scan::hash_files(&mut files, &resolved);
                                        all_files.extend(files);
                                    }

                                    // Match against DAT index (loaded lazily)
                                    let mut dat_lock = dat_index.write().await;
                                    if dat_lock.is_none() {
                                        // Try to load DATs for each extension we found
                                        // sharing the mutability borrow
                                        for file in &all_files {
                                            if let Some(ext) = file
                                                .relative_path
                                                .rsplit('.')
                                                .next()
                                                && let Some(index) = crate::dat::load_for_extension(
                                                    ext,
                                                    &dirs::cache_dir()
                                                        .unwrap_or_default()
                                                        .join("games-vault")
                                                        .join("dat"),
                                                )
                                                .await
                                            {
                                                *dat_lock = Some(index);
                                                break;
                                            }
                                        }
                                    }

                                    let mut matches = Vec::new();
                                    for file in &all_files {
                                        let dat_match = if let (
                                            Some(crc),
                                            Some(sha),
                                        ) = (&file.crc, &file.sha256)
                                        {
                                            dat_lock
                                                .as_ref()
                                                .and_then(|idx| {
                                                    crate::dat::match_entry(
                                                        idx, crc, sha,
                                                    )
                                                })
                                                .map(|e| {
                                                    serde_json::json!({
                                                        "name": e.canonical_name,
                                                        "game_name": e.game_name,
                                                    })
                                                })
                                        } else {
                                            None
                                        };

                                        matches.push(serde_json::json!({
                                            "file": file,
                                            "match": dat_match,
                                        }));
                                    }

                                    drop(dat_lock);

                                    let result =
                                        serde_json::json!({ "matches": matches });
                                    if let Err(e) = client
                                        .command_result(&cmd.id, &result)
                                        .await
                                    {
                                        tracing::error!(
                                            "[SCAN] failed to report result: {e:#}"
                                        );
                                    }
                                }
                            }
                        }
                        tokio::time::sleep(Duration::from_millis(resp.next_poll_ms)).await;
                    }
                    Err(e) => {
                        tracing::error!("[POLL] error: {:#}", e);
                        tracing::warn!(
                            "[POLL] backing off {}s before retry...",
                            POLL_ERROR_BACKOFF_MS / 1000
                        );
                        tokio::time::sleep(Duration::from_millis(POLL_ERROR_BACKOFF_MS)).await;
                    }
                }
            } => {}
        }
    }

    // Drain workers — kill each one and wait for it to exit
    for (game_id, worker) in workers {
        tracing::info!("[SHUTDOWN] stopping worker for game {game_id}");
        worker.kill().await;
    }

    tracing::info!("[SHUTDOWN] done");
    Ok(())
}

fn internal_worker_url(public_url: &str) -> String {
    // Extract port from public URL like "http://192.168.86.126:3060"
    // and rewrite to "http://127.0.0.1:{port}"
    if let Some(colon) = public_url.rfind(':')
        && let Ok(port) = public_url[colon + 1..].parse::<u16>()
    {
        return format!("http://127.0.0.1:{port}");
    }
    // Fallback — shouldn't happen with well-formed worker URLs
    public_url.to_string()
}

// ── Shutdown signal ───────────────────────────────────────────────────

/// Returns when the process receives SIGINT (Ctrl+C) or SIGTERM.
#[cfg(unix)]
async fn shutdown_signal() {
    use tokio::signal::unix::{signal, SignalKind};

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
