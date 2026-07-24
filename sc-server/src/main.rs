mod commands;
mod config;
mod core_bridge;
mod dat;
mod encoder_probe;
mod gst_audio;
mod gst_video;
mod install;
mod nat;
mod platform;
mod player_server;
mod retry;
mod saves;
mod sc_web;
mod scan;
mod scan_cmd;
mod session;
mod setup;
mod streaming;
mod webrtc;

use anyhow::Result;
use clap::{Parser, Subcommand};

#[derive(Parser)]
#[command(name = "sc-server", about = "Sprite Cloud server", version)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Interactive first-run setup wizard (NAT check, ROM paths, STUN config)
    Setup,

    /// Install as a systemd user service (auto-start on boot)
    Install,

    /// Discover ROMs and print platform breakdown
    Scan {
        /// Upload results to sc-web after scanning
        #[arg(long)]
        upload: bool,
    },

    /// Pair with a Sprite Cloud account
    Pair {
        /// Pairing code from the web dashboard
        code: String,
        /// Sprite Cloud web URL
        #[arg(long, default_value = "https://sprite-cloud.com")]
        sc_web_url: String,
    },

    /// Start serving (poll sc-web for game requests)
    Start {
        /// Override the sc-web URL from config
        #[arg(long)]
        sc_web_url: Option<String>,

        /// Disable the LAN player HTTP endpoint (port 8787).
        /// Use this when you only want relay-based play through sc-web.
        #[arg(long)]
        no_lan_player: bool,

        /// Run without pairing to sc-web. Serves a local game library API
        /// on the player port. Scan ROMs, launch games — no cloud account needed.
        #[arg(long)]
        standalone: bool,
    },
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .json()
        .with_target(false)
        .with_timer(tracing_subscriber::fmt::time::UtcTime::rfc_3339())
        .init();

    let _root = tracing::info_span!("", service = "sc-server").entered();

    let cli = Cli::parse();

    match cli.command {
        Command::Setup => setup::run().await,
        Command::Install => install::run(),
        Command::Scan { upload } => scan_cmd::run(upload).await,
        Command::Pair { code, sc_web_url } => commands::cmd_pair(&code, &sc_web_url).await,
        Command::Start { sc_web_url, no_lan_player, standalone } => commands::cmd_start(sc_web_url, no_lan_player, standalone).await,
    }
}
