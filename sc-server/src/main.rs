mod commands;
mod config;
mod core_bridge;
mod dat;
mod encoder_probe;
mod gst_audio;
mod gst_video;
mod sc_web;
mod platform;
mod player_server;
mod retry;
mod saves;
mod scan;
mod session;
mod streaming;
mod webrtc;

use anyhow::Result;
use clap::{Parser, Subcommand};

#[derive(Parser)]
#[command(name = "sc-server", about = "Sprite Cloud server")]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    Pair {
        code: String,
        #[arg(long, default_value = "http://localhost:3001")]
        sc_web_url: String,
    },
    Start {
        #[arg(long)]
        sc_web_url: Option<String>,
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
        Command::Pair { code, sc_web_url } => commands::cmd_pair(&code, &sc_web_url).await,
        Command::Start { sc_web_url } => commands::cmd_start(sc_web_url).await,
    }
}
