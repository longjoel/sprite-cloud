mod config;
mod gv_web;
mod retry;
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

    let resp = gv_web::GvWebClient::claim(code, gv_web_url).await?;

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
                                    tracing::info!(
                                        "[POLL] start_game command {} (game: {})",
                                        cmd.id, game_id
                                    );

                                    match worker::spawn_worker(game_id, worker_bin.as_deref()).await {
                                        Ok(worker) => {
                                            let url = worker.url.clone();
                                            tracing::info!("[WORKER] spawned at {url}");

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
