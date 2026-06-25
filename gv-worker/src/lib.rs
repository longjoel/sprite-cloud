pub mod config;
pub mod encoder_probe;
pub mod gst_video;
pub mod gst_audio;
pub mod core_bridge;
pub mod saves;
pub mod player_assets;
pub mod main_body;

use std::sync::Arc;

use gv_shm::ShmRing;
use tokio_util::sync::CancellationToken;

use main_body::{AppState, StreamCtx, stream_frames};

pub const VERSION: &str = env!("CARGO_PKG_VERSION");
pub const LIBRETRO_RUNNER_VERSION: &str = libretro_runner::VERSION;

/// Run the worker as a pure media engine — opens shared memory, loads core,
/// starts GStreamer pipelines, and writes encoded frames to the shm ring.
pub async fn run_worker(shm_name: &str) -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt()
        .json()
        .with_target(false)
        .with_current_span(false)
        .try_init()
        .ok();

    gstreamer::init().map_err(|e| format!("gst init: {e}"))?;

    let shm = Arc::new(ShmRing::open(shm_name)?);
    tracing::info!("[WORKER] opened shm ring '{}' ({} frames)", shm_name, shm.frame_count());

    let state = Arc::new(AppState::new());
    let cancel = CancellationToken::new();
    *state.cancel.lock().await = cancel.clone();

    // Spawn the streaming loop (handles core loading + GStreamer + shm writes)
    let stream_ctx = StreamCtx {
        cancel: cancel.clone(),
        app_state: Arc::clone(&state),
        shm: Arc::clone(&shm),
    };

    let stream_handle = tokio::spawn(async move {
        stream_frames(stream_ctx).await;
    });

    // Signal readiness to parent (gv-server polls for this)
    eprintln!("WORKER_READY");

    // Run until cancelled or streaming exits
    tokio::select! {
        _ = tokio::signal::ctrl_c() => {
            tracing::info!("[WORKER] SIGINT — shutting down");
        }
        _ = stream_handle => {
            tracing::info!("[WORKER] streaming loop exited");
        }
    }

    cancel.cancel();
    tracing::info!("[WORKER] done");
    Ok(())
}
