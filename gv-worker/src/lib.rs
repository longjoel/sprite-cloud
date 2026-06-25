//! gv-worker binary library entry point.
//!
//! Shared-memory media engine — loads a libretro core, runs GStreamer
//! pipelines, and writes encoded H.264/Opus frames to a shared-memory
//! ring buffer. No networking, no HTTP server, no WebRTC.
//!
//! WebRTC and SDP are handled by gv-server in-process.

pub mod config;
pub mod core_bridge;
pub mod encoder_probe;
pub mod gst_audio;
pub mod gst_video;
pub mod main_body;
pub mod saves;
pub mod player_assets;

use std::sync::Arc;

use gv_shm::ShmRing;
use tokio_util::sync::CancellationToken;

use main_body::{AppState, StreamCtx, stream_frames};

pub const VERSION: &str = env!("CARGO_PKG_VERSION");
pub const LIBRETRO_RUNNER_VERSION: &str = libretro_runner::VERSION;

/// Run the worker as a pure media engine — opens shared memory, loads core,
/// starts GStreamer pipelines, and writes encoded frames to the shm ring.
/// If `input_shm_name` is provided, polls it for keyboard/gamepad input.
pub async fn run_worker(shm_name: &str, input_shm_name: Option<&str>) -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt()
        .json()
        .with_target(false)
        .with_timer(tracing_subscriber::fmt::time::UtcTime::rfc_3339())
        .try_init()
        .ok();

    gstreamer::init().map_err(|e| format!("gst init: {e}"))?;

    let shm = Arc::new(ShmRing::open(shm_name)?);
    tracing::info!("[WORKER] opened shm ring '{}' ({} frames)", shm_name, shm.frame_count());

    let state = Arc::new(AppState::new());
    let cancel = CancellationToken::new();
    *state.cancel.lock().await = cancel.clone();

    // ── Load the libretro core ──────────────────────────────────────────
    // Reads GV_CORE_PATH and GV_CONTENT_PATH from env vars (set by gv-server).
    // If core loading fails, the worker falls back to a test pattern in the
    // streaming loop (core_loading / core_loaded flags remain false).
    // Load the libretro core.  Must be done here (not in a spawned task) so
    // the AppState fields are populated before the streaming loop starts.
    let core_handle = core_bridge::spawn_core_thread();
    if let Some(handle) = core_handle {
        tracing::info!(
            "[WORKER] core loaded: {}×{} @ {:.1}fps",
            handle.width, handle.height, handle.fps
        );
        *state.core_width.lock().await = handle.width;
        *state.core_height.lock().await = handle.height;
        *state.core_fps.lock().await = handle.fps;
        *state.core_frame_rx.lock().await = Some(handle.frame_rx);
        *state.core_cmd_tx.lock().await = Some(handle.cmd_tx);
        *state.core_response_rx.lock().await = Some(handle.response_rx);
        state.core_loaded.store(true, std::sync::atomic::Ordering::Relaxed);
    } else {
        tracing::warn!("[WORKER] core failed to load — test pattern will be used");
    }

    // Spawn the streaming loop (handles core frame drain + GStreamer + shm writes)
    let input_shm: Option<Arc<ShmRing>> = match input_shm_name {
        Some(name) => {
            let ishm = Arc::new(ShmRing::open(name)?);
            tracing::info!("[WORKER] opened input shm ring '{}' ({} frames)", name, ishm.frame_count());
            Some(ishm)
        }
        None => None,
    };
    let stream_ctx = StreamCtx {
        cancel: cancel.clone(),
        app_state: Arc::clone(&state),
        shm: Arc::clone(&shm),
        input_shm,
    };

    let stream_handle = tokio::spawn(async move {
        stream_frames(stream_ctx).await;
    });

    // Signal readiness to parent (gv-server polls for this)
    eprintln!("WORKER_READY");

    // Wait for stream to finish or cancel signal
    tokio::select! {
        _ = cancel.cancelled() => {
            tracing::info!("[WORKER] cancel signal received");
        }
        _ = stream_handle => {
            tracing::info!("[WORKER] stream loop exited");
        }
    }

    tracing::info!("[WORKER] shutting down");
    Ok(())
}
