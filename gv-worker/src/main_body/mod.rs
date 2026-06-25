//! GStreamer-powered streaming engine — reads from libretro core, encodes
//! via GStreamer, writes to shared memory. No networking, no HTTP server.
//!
//! WebRTC and SDP handling moved to gv-server/src/webrtc.rs.

use std::sync::atomic::{AtomicBool, AtomicU64};
use std::sync::Arc;

use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;

use crate::core_bridge::{CoreCommand, CoreFrame, CoreResponse};
use crate::gst_audio::GstAudioEncoder;
use crate::gst_video::GstVideoEncoder;

// ── Application state ────────────────────────────────────────────────────────

pub(super) struct AppState {
    pub(super) cancel: Mutex<CancellationToken>,
    pub(super) core_loaded: AtomicBool,
    pub(super) core_loading: AtomicBool,
    pub(super) core_ready_notify: tokio::sync::Notify,
    pub(super) frames_encoded: AtomicU64,
    pub(super) core_error: Mutex<Option<String>>,
    pub(super) core_cmd_tx: Mutex<Option<std::sync::mpsc::SyncSender<CoreCommand>>>,
    pub(super) core_frame_rx: Mutex<Option<std::sync::mpsc::Receiver<CoreFrame>>>,
    pub(super) core_response_rx: Mutex<Option<std::sync::mpsc::Receiver<CoreResponse>>>,
    pub(super) video_enc: Mutex<Option<Arc<tokio::sync::Mutex<GstVideoEncoder>>>>,
    pub(super) audio_enc: Mutex<Option<Arc<tokio::sync::Mutex<Option<GstAudioEncoder>>>>>,
    pub(super) core_width: Mutex<u32>,
    pub(super) core_height: Mutex<u32>,
    pub(super) core_fps: Mutex<f64>,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            cancel: Mutex::new(CancellationToken::new()),
            core_loaded: AtomicBool::new(false),
            core_loading: AtomicBool::new(false),
            core_ready_notify: tokio::sync::Notify::new(),
            frames_encoded: AtomicU64::new(0),
            core_error: Mutex::new(None),
            core_cmd_tx: Mutex::new(None),
            core_frame_rx: Mutex::new(None),
            core_response_rx: Mutex::new(None),
            video_enc: Mutex::new(None),
            audio_enc: Mutex::new(None),
            core_width: Mutex::new(0),
            core_height: Mutex::new(0),
            core_fps: Mutex::new(0.0),
        }
    }
}

// ── Modules ──────────────────────────────────────────────────────────────────

mod streaming;
pub use streaming::stream_frames;
pub use streaming::StreamCtx;
