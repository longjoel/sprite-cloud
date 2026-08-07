//! Per-game session: libretro core + GStreamer pipeline + WebRTC tracks.
//!
//! Session runtime for core execution, GStreamer encoding, WebRTC, and input.
//! (IPC ring buffer), and sc-server (fan_out_frames) is now one struct.
//! No cross-process IPC, no spawn, no WORKER_READY parsing.

use std::sync::Arc;
use std::sync::Mutex as StdMutex;
use std::sync::atomic::{AtomicBool, AtomicU32};
use tokio::sync::Mutex;

use webrtc::data_channel::RTCDataChannel;
use webrtc::peer_connection::RTCPeerConnection;
use webrtc::track::track_local::track_local_static_sample::TrackLocalStaticSample;

use crate::core_bridge::{CoreCommand, CoreFrame, CoreResponse};
use crate::gst_audio::GstAudioEncoder;
use crate::gst_video::GstVideoEncoder;

/// A connected guest peer with their own PC.
pub struct GuestPeer {
    pub pc: Arc<RTCPeerConnection>,
    pub peer_token: String,
}

pub struct GameSession {
    /// Human-friendly identifier for logging.
    pub game_id: String,
    /// Cloud coordination session UUID, when this runtime was started by sc-web.
    pub cloud_session_id: Option<String>,
    /// Cancel token — signals the streaming loop and fan-out to stop.
    pub cancel: tokio_util::sync::CancellationToken,
    /// Completion token — cancelled only after the core bridge has captured
    /// shutdown SRAM, terminated the child, and released shared memory.
    pub core_stopped: tokio_util::sync::CancellationToken,

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
    /// Authenticated account id for artifact attribution (#745). None until
    /// the DC auth message resolves it; save/load calls fall back to
    /// `"shared"` while unset.
    pub account_id: tokio::sync::Mutex<Option<String>>,

    // ── Core (libretro) ─────────────────────────────────────────────
    pub core_loaded: AtomicBool,
    pub core_loading: AtomicBool,
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
    /// Core audio sample rate in Hz (from retro_get_system_av_info).
    pub core_sample_rate: Mutex<f64>,
    /// Resident session — never idle-killed, periodically checkpointed.
    pub resident: AtomicBool,
}

impl GameSession {
    /// Account id for artifact attribution (#745).
    ///
    /// Returns the authenticated account when the DC auth message has
    /// resolved one; otherwise the `"shared"` fallback so pre-auth SRAM
    /// auto-load/auto-save (core startup, session teardown) still works.
    pub async fn effective_account_id(&self) -> String {
        self.account_id
            .lock()
            .await
            .clone()
            .unwrap_or_else(|| "shared".to_string())
    }
}
