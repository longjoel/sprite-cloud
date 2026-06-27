//! Per-game session: libretro core + GStreamer pipeline + WebRTC tracks.
//!
//! Session runtime for core execution, GStreamer encoding, WebRTC, and input.
//! (IPC ring buffer), and gv-server (fan_out_frames) is now one struct.
//! No cross-process IPC, no spawn, no WORKER_READY parsing.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU32};
use std::sync::Mutex as StdMutex;
use tokio::sync::Mutex;

use webrtc::peer_connection::RTCPeerConnection;
use webrtc::track::track_local::track_local_static_sample::TrackLocalStaticSample;
use webrtc::data_channel::RTCDataChannel;

use crate::core_bridge::{CoreCommand, CoreFrame, CoreResponse};
use crate::gst_audio::GstAudioEncoder;
use crate::gst_video::GstVideoEncoder;

/// A connected guest peer with their own PC and input seat.
pub struct GuestPeer {
    pub pc: Arc<RTCPeerConnection>,
    pub seat: u32,
    pub peer_token: String,
}

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
    /// DataChannel to the host browser — set after auth handshake.
    /// Used by the streaming loop to send `core_died` on crash.
    pub dc: Mutex<Option<Arc<RTCDataChannel>>>,
    /// Guest peer connections — host is `session.pc`, guests are here.
    pub guests: Mutex<Vec<Arc<GuestPeer>>>,
    /// True while the host DataChannel is open. Guest leave only
    /// cancels the session if this is false (host already gone).
    pub host_connected: AtomicBool,
    /// Number of local player ports on the host machine (gamepads + keyboard on seat 0).
    /// Used to offset guest seat assignment so local multi-controller doesn't collide.
    /// Defaults to 1 (keyboard + gamepad[0] on seat 0). Set from host auth message.
    pub local_players: AtomicU32,

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

    // ── Save stack ──────────────────────────────────────────────────
    /// ROM content hash for save directory lookup.
    pub rom_hash: Mutex<Option<String>>,

    // ── Core metadata ───────────────────────────────────────────────
    pub core_width: Mutex<u32>,
    pub core_height: Mutex<u32>,
    pub core_fps: Mutex<f64>,
    pub frames_encoded: std::sync::atomic::AtomicU64,
}
