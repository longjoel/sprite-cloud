//! HTTP server, WebRTC SDP handshake, and GStreamer-powered streaming loop.
//!
//! Adapted from v1 main_body.rs. Key changes:
//! - GStreamer encoders replace raw libvpx FFI + rubato/opus
//! - No test pattern fallback (core required or error)
//! - No spawn_blocking (GStreamer runs in its own thread pool)
//! - Audio RTP timestamps use incrementing counter (v1 bug fix)

use std::sync::atomic::{AtomicBool, AtomicU64};
use std::sync::Arc;

use axum::{
    routing::{get, post}, Router,
};
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;
use tower_http::cors::CorsLayer;

use ::webrtc::peer_connection::RTCPeerConnection;
use ::webrtc::track::track_local::track_local_static_sample::TrackLocalStaticSample;

use crate::config::{self};
use crate::core_bridge::{CoreCommand, CoreFrame, CoreResponse};
use crate::gst_audio::GstAudioEncoder;
use crate::gst_video::GstVideoEncoder;
use std::collections::HashMap;

// ── Types ───────────────────────────────────────────────────────────────────

type PeerId = String; // peer_token (32-char hex)

#[derive(Debug, Deserialize)]
pub(super) struct SdpOffer {
    sdp: String,
    #[serde(default)]
    peer_token: Option<String>,
    #[serde(default)]
    host_token: Option<String>,
    /// Trusted peer_role from gv-web (pre-validated against peer_tokens DB)
    #[serde(default)]
    peer_role: Option<String>,
    /// Trusted peer_seat from gv-web
    #[serde(default)]
    peer_seat: Option<u32>,
}

impl SdpOffer {
    pub(super) fn effective_token(&self) -> Option<&str> {
        self.peer_token.as_deref().or(self.host_token.as_deref())
    }

    /// Returns (role, seat) from trusted gv-web enrichment, if present
    pub(super) fn trusted_role_seat(&self) -> Option<(PeerRole, u32)> {
        match (self.peer_role.as_deref(), self.peer_seat) {
            (Some("host"), seat) => Some((PeerRole::Host, seat.unwrap_or(0))),
            (Some("player"), seat) => Some((PeerRole::Player, seat.unwrap_or(0))),
            (Some("viewer"), seat) => Some((PeerRole::Viewer, seat.unwrap_or(0))),
            _ => None,
        }
    }
}

#[derive(Debug, Serialize)]
pub(super) struct SdpAnswer {
    sdp: String,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub(super) enum PeerRole {
    Host,
    Player,
    Viewer,
}

/// Per-peer connection lifecycle state machine.
/// Replaces ad-hoc Option<PeerRole> tracking with explicit states.
#[derive(Debug, Clone)]
enum PeerLifecycle {
    /// WebRTC negotiation in progress (ICE gathering, SDP exchange, track setup)
    Negotiating,
    /// DataChannel received, waiting for auth message (with timeout)
    Authenticating { since: std::time::Instant },
    /// Fully connected and authorized — input, save/load, and commands allowed
    Active { role: PeerRole, seat: u32 },
    /// Connection failed, closed, or auth timed out — tombstone, swept on reconnect
    Disconnected,
}

struct PeerState {
    pc: Arc<RTCPeerConnection>,
    lifecycle: PeerLifecycle,
    /// DataChannel send handle (for stats, core response forwarding).
    /// Lifecycle enum tracks auth state; this is just the I/O pipe.
    dc_stream: Arc<tokio::sync::Mutex<Option<Arc<::webrtc::data_channel::RTCDataChannel>>>>,
    video_track: Arc<TrackLocalStaticSample>,
    audio_track: Arc<TrackLocalStaticSample>,
}

/// Broadcast room state to all peers with an open DataChannel.
async fn broadcast_room_state(state: &AppState) {
    let peers = state.peers.lock().await;
    let members: Vec<serde_json::Value> = peers
        .iter()
        .filter_map(|(id, p)| {
            let (role, seat) = match &p.lifecycle {
                PeerLifecycle::Active { role, seat } => (
                    match role {
                        PeerRole::Host => "host",
                        PeerRole::Player => "player",
                        PeerRole::Viewer => "viewer",
                    },
                    *seat,
                ),
                _ => return None, // skip Negotiating/Authenticating/Disconnected
            };
            Some(serde_json::json!({
                "id": &id[..8.min(id.len())],
                "seat": seat,
                "role": role,
            }))
        })
        .collect();

    let msg = serde_json::json!({
        "type": "room_state",
        "members": members,
    });
    let msg_str = msg.to_string();

    for (_, peer) in peers.iter() {
        if let Some(dc) = peer.dc_stream.lock().await.as_ref() {
            if dc.ready_state() == ::webrtc::data_channel::data_channel_state::RTCDataChannelState::Open {
                let _ = dc.send_text(&msg_str).await;
            }
        }
    }
}

pub(super) struct AppState {
    pub(super) cancel: Mutex<CancellationToken>,
    pub(super) stream_handle: Mutex<Option<JoinHandle<()>>>,
    pub(super) peers: Mutex<HashMap<PeerId, PeerState>>,
    pub(super) peer_tokens: Vec<config::PeerToken>,
    pub(super) control_token: Option<String>,
    pub(super) exit_signal: CancellationToken,
    pub(super) destruct_timer: Mutex<Option<JoinHandle<()>>>,
    pub(super) core_loaded: AtomicBool,
    pub(super) frames_encoded: AtomicU64,
    // ── Shared session state (extracted from do_webrtc_handshake) ──
    #[allow(dead_code)]
    session_active: AtomicBool,
    pub(super) core_spawning: Mutex<()>,  // serialize core loads — libretro not reentrant
    pub(super) core_error: Mutex<Option<String>>,  // set when core fails to load ROM
    pub(super) core_cmd_tx: Mutex<Option<std::sync::mpsc::SyncSender<CoreCommand>>>,
    pub(super) core_frame_rx: Mutex<Option<std::sync::mpsc::Receiver<CoreFrame>>>,
    pub(super) core_response_rx: Mutex<Option<std::sync::mpsc::Receiver<CoreResponse>>>,
    pub(super) video_enc: Mutex<Option<Arc<tokio::sync::Mutex<GstVideoEncoder>>>>,
    pub(super) audio_enc: Mutex<Option<Arc<tokio::sync::Mutex<Option<GstAudioEncoder>>>>>,
    pub(super) core_width: Mutex<u32>,
    pub(super) core_height: Mutex<u32>,
    pub(super) core_fps: Mutex<f64>,
}

// ── HTTP handlers ───────────────────────────────────────────────────────────

mod handlers;

// ── App builder ─────────────────────────────────────────────────────────────

pub async fn build_app() -> Result<Router, Box<dyn std::error::Error>> {
    let peer_tokens = config::peer_tokens();
    let control_token = config::worker_control_token();
    if control_token.is_some() {
        tracing::info!("[STARTUP] worker control token required for HTTP control endpoints");
    }
    if !peer_tokens.is_empty() {
        tracing::info!("[STARTUP] {} peer token(s) loaded", peer_tokens.len());
    }

    let state = Arc::new(AppState {
        cancel: Mutex::new(CancellationToken::new()),
        stream_handle: Mutex::new(None),
        peers: Mutex::new(HashMap::new()),
        peer_tokens,
        control_token,
        exit_signal: CancellationToken::new(),
        destruct_timer: Mutex::new(None),
        core_loaded: AtomicBool::new(false),
        frames_encoded: AtomicU64::new(0),
        session_active: AtomicBool::new(false),
        core_spawning: Mutex::new(()),
        core_error: Mutex::new(None),
        core_cmd_tx: Mutex::new(None),
        core_frame_rx: Mutex::new(None),
        core_response_rx: Mutex::new(None),
        video_enc: Mutex::new(None),
        audio_enc: Mutex::new(None),
        core_width: Mutex::new(0),
        core_height: Mutex::new(0),
        core_fps: Mutex::new(0.0),
    });

    let cors = CorsLayer::new()
        .allow_origin(
            config::allowed_origins()
                .into_iter()
                .map(|o| o.parse::<axum::http::HeaderValue>().unwrap())
                .collect::<Vec<_>>(),
        )
        .allow_methods(tower_http::cors::Any)
        .allow_headers(tower_http::cors::Any);

    let app = Router::new()
        .route("/", get(handlers::handle_root))
        .route("/player", get(handlers::handle_player))
        .route("/player/index.js", get(|| async {
            crate::player_assets::serve_player_file("index.js")
        }))
        .route("/player/player-entry.js", get(|| async {
            crate::player_assets::serve_player_file("player-entry.js")
        }))
        .route("/player/player-bundle.js", get(|| async {
            crate::player_assets::serve_player_file("player-bundle.js")
        }))
        .route("/sdp", post(handlers::handle_offer))
        .route("/state", get(handlers::handle_connection_state))
        .route("/health", get(handlers::handle_health))
        .route("/healthz", get(handlers::handle_healthz))
        .route("/shutdown", post(handlers::handle_shutdown))
        .layer(cors)
        .with_state(state);

    Ok(app)
}

// ── Submodules ──────────────────────────────────────────────────────────────
mod webrtc;
mod streaming;
mod input;

pub(super) use webrtc::do_webrtc_handshake;