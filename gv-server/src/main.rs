mod config;
mod gv_web;

use anyhow::{Context, Result};
use clap::{Parser, Subcommand};

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
    let cli = Cli::parse();

    match cli.command {
        Command::Pair { code, gv_web_url } => cmd_pair(&code, &gv_web_url).await,
        Command::Start { gv_web_url } => cmd_start(gv_web_url).await,
    }
}

// ── pair subcommand ───────────────────────────────────────────────────

async fn cmd_pair(code: &str, gv_web_url: &str) -> Result<()> {
    println!("Pairing with {} ...", gv_web_url);

    let resp = gv_web::GvWebClient::claim(code, gv_web_url).await?;

    let cfg = config::Config {
        gv_web: config::GvWeb {
            url: gv_web_url.to_string(),
        },
        auth: config::Auth {
            api_key: resp.api_key.clone(),
            server_id: resp.server_id.clone(),
        },
    };

    config::save(&cfg).context("save config")?;

    println!("Paired!");
    println!("  server_id: {}", resp.server_id);
    println!(
        "  api_key:   {}",
        &resp.api_key[..8.min(resp.api_key.len())]
    );
    println!("  config saved");

    Ok(())
}

// ── start subcommand ──────────────────────────────────────────────────

async fn cmd_start(gv_web_url: Option<String>) -> Result<()> {
    let mut cfg = config::load().context("load config (run 'gv-server pair' first)")?;

    if let Some(url) = gv_web_url {
        cfg.gv_web.url = url;
    }

    let client = gv_web::GvWebClient::new(cfg.gv_web.url.clone(), cfg.auth.clone());

    // Verify the API key is still valid
    let verify = client.verify().await?;
    println!(
        "Connected to gv-web as server {} (user: {})",
        verify.server_id, verify.user_id
    );

    println!("gv-server running — polling for commands...");

    // Backoff on poll errors (not a server-controlled interval).
    const POLL_ERROR_BACKOFF_MS: u64 = 5_000;

    loop {
        match client.poll().await {
            Ok(resp) => {
                if resp.commands.is_empty() {
                    // No commands — sleep as directed by the server.
                } else {
                    for cmd in &resp.commands {
                        println!(
                            "[POLL] command {}: {} {}",
                            cmd.id,
                            cmd.command_type,
                            cmd.payload,
                        );
                    }
                }
                tokio::time::sleep(std::time::Duration::from_millis(resp.next_poll_ms)).await;
            }
            Err(e) => {
                eprintln!("[POLL] error: {:#}", e);
                eprintln!(
                    "[POLL] backing off {}s before retry...",
                    POLL_ERROR_BACKOFF_MS / 1000
                );
                tokio::time::sleep(std::time::Duration::from_millis(POLL_ERROR_BACKOFF_MS)).await;
            }
        }
    }
}
