//! Per-game session: libretro core + GStreamer pipeline + WebRTC tracks.
//!
//! Everything that was split across gv-worker (core/GStreamer), gv-shm
//! (IPC ring buffer), and gv-server (fan_out_frames) is now one struct.
//! No cross-process IPC, no spawn, no WORKER_READY parsing.

use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use std::sync::Mutex as StdMutex;
use tokio::sync::Mutex;

use webrtc::peer_connection::RTCPeerConnection;
use webrtc::track::track_local::track_local_static_sample::TrackLocalStaticSample;

use crate::core_bridge::{CoreCommand, CoreFrame, CoreResponse};
use crate::gst_audio::GstAudioEncoder;
use crate::gst_video::GstVideoEncoder;

pub struct GameSession {
    /// Human-friendly identifier for logging.
    pub game_id: String,
    /// gv-web session UUID (for notify / generation tracking).
    pub session_id: String,
    /// Cancel token — signals the streaming loop and fan-out to stop.
    pub cancel: tokio_util::sync::CancellationToken,

    // ── WebRTC ──────────────────────────────────────────────────────
    pub pc: StdMutex<Arc<RTCPeerConnection>>,
    pub video_track: StdMutex<Arc<TrackLocalStaticSample>>,
    pub audio_track: StdMutex<Arc<TrackLocalStaticSample>>,

    // ── Core (libretro) ─────────────────────────────────────────────
    pub core_loaded: AtomicBool,
    pub core_loading: AtomicBool,
    pub core_ready_notify: tokio::sync::Notify,
    pub core_cmd_tx: Mutex<Option<std::sync::mpsc::SyncSender<CoreCommand>>>,
    pub core_frame_rx: Mutex<Option<std::sync::mpsc::Receiver<CoreFrame>>>,
    pub core_response_rx: Mutex<Option<std::sync::mpsc::Receiver<CoreResponse>>>,

    // ── GStreamer encoders ──────────────────────────────────────────
    pub video_enc: Mutex<Option<Arc<Mutex<GstVideoEncoder>>>>,
    pub audio_enc: Mutex<Option<Arc<Mutex<Option<GstAudioEncoder>>>>>,

    // ── Core metadata ───────────────────────────────────────────────
    pub core_width: Mutex<u32>,
    pub core_height: Mutex<u32>,
    pub core_fps: Mutex<f64>,
    pub frames_encoded: std::sync::atomic::AtomicU64,
}
