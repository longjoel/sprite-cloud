pub mod config;
pub mod encoder_probe;
pub mod gst_video;
pub mod gst_audio;
pub mod core_bridge;
pub mod saves;
pub mod player_assets;
pub mod main_body;

use std::net::SocketAddr;
use tokio::net::TcpListener;

pub const VERSION: &str = env!("CARGO_PKG_VERSION");
pub const LIBRETRO_RUNNER_VERSION: &str = libretro_runner::VERSION;

pub async fn run_worker(port: u16) -> Result<(), Box<dyn std::error::Error>> {
    // try_init so single-binary dispatch (gv-server worker) doesn't panic
    // when the parent already initialized the global subscriber.
    tracing_subscriber::fmt()
        .json()
        .with_target(false)
        .with_current_span(false)
        .try_init()
        .ok();

    gstreamer::init().map_err(|e| format!("gst init: {e}"))?;

    let app = main_body::build_app().await?;
    let addr = SocketAddr::from(([0, 0, 0, 0], port));
    let listener = TcpListener::bind(addr).await?;
    let bound_port = listener.local_addr()?.port();

    tracing::info!("gv-worker listening on port {bound_port}");
    eprintln!("WORKER_READY port={bound_port}");
    tracing::info!("open http://localhost:{bound_port}");

    axum::serve(listener, app)
        .with_graceful_shutdown(async move {
            tokio::signal::ctrl_c().await.ok();
        })
        .await?;

    Ok(())
}
