mod config;
mod commands;
mod dat;
mod gv_web;
mod local;
mod platform;
mod retry;
mod scan;
mod worker;

use anyhow::{Context, Result};
use clap::{Parser, Subcommand};
use std::collections::HashMap;
use std::path::PathBuf;
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
    /// Run as a gv-worker (internal — spawned by `gv-server start`)
    Worker {
        /// Port to bind (0 = random)
        port: u16,
    },
    /// Start local HTTP server for LAN-only play (no pairing required)
    Local {
        /// Port to listen on (default: 8090)
        #[arg(long, default_value = "8090")]
        port: u16,
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
        Command::Pair { code, gv_web_url } => commands::cmd_pair(&code, &gv_web_url).await,
        Command::Start { gv_web_url } => commands::cmd_start(gv_web_url).await,
        Command::Worker { port } => {
            gv_worker::run_worker(port).await.map_err(|e| anyhow::anyhow!("{e}"))
        }
        Command::Local { port } => local::serve(port).await,
    }
}
