//! HTTP server, WebRTC SDP handshake, and GStreamer-powered streaming loop.
//!
//! Adapted from v1 main_body.rs. Key changes:
//! - GStreamer encoders replace raw libvpx FFI + rubato/opus
//! - No test pattern fallback (core required or error)
//! - No spawn_blocking (GStreamer runs in its own thread pool)
//! - Audio RTP timestamps use incrementing counter (v1 bug fix)

use std::net::IpAddr;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use axum::{
    routing::{get, post}, Router,
};
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;
use tower_http::cors::CorsLayer;
use webrtc::api::interceptor_registry::register_default_interceptors;
use webrtc::api::media_engine::{MediaEngine, MIME_TYPE_H264, MIME_TYPE_OPUS, MIME_TYPE_VP8};
use webrtc::api::setting_engine::SettingEngine;
use webrtc::api::APIBuilder;
use webrtc::ice_transport::ice_server::RTCIceServer;
use webrtc::ice::network_type::NetworkType;
use webrtc::ice::mdns::MulticastDnsMode;
use webrtc::peer_connection::configuration::RTCConfiguration;
use webrtc::peer_connection::peer_connection_state::RTCPeerConnectionState;
use webrtc::peer_connection::policy::ice_transport_policy::RTCIceTransportPolicy;
use webrtc::peer_connection::sdp::session_description::RTCSessionDescription;
use webrtc::peer_connection::RTCPeerConnection;
use webrtc::rtp_transceiver::rtp_codec::RTCRtpCodecCapability;
use webrtc::track::track_local::track_local_static_sample::TrackLocalStaticSample;
use webrtc::track::track_local::TrackLocal;

use crate::config::{
    self, dc_auth_timeout_secs, ice_config, AUDIO_CHANNELS, AUDIO_SAMPLE_RATE, AUDIO_TRACK_ID,
    DC_RECEIVE_TIMEOUT_SECS, ICE_GATHERING_TIMEOUT_SECS, OPUS_SDP_FMTP, STATS_SEND_INTERVAL,
    STREAM_ID, VIDEO_TRACK_ID, VP8_CLOCK_RATE,
};
use crate::core_bridge::{CoreCommand, CoreFrame};
use crate::core_bridge::CoreResponse;
use crate::gst_audio::GstAudioEncoder;
use crate::gst_video::{GstVideoEncoder, VideoCodec};
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
    dc_stream: Arc<tokio::sync::Mutex<Option<Arc<webrtc::data_channel::RTCDataChannel>>>>,
    video_track: Arc<TrackLocalStaticSample>,
    audio_track: Arc<TrackLocalStaticSample>,
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
    core_spawning: Mutex<()>,  // serialize core loads — libretro not reentrant
    core_cmd_tx: Mutex<Option<std::sync::mpsc::SyncSender<CoreCommand>>>,
    core_frame_rx: Mutex<Option<std::sync::mpsc::Receiver<CoreFrame>>>,
    core_response_rx: Mutex<Option<std::sync::mpsc::Receiver<CoreResponse>>>,
    video_enc: Mutex<Option<Arc<tokio::sync::Mutex<GstVideoEncoder>>>>,
    audio_enc: Mutex<Option<Arc<tokio::sync::Mutex<Option<GstAudioEncoder>>>>>,
    core_width: Mutex<u32>,
    core_height: Mutex<u32>,
    core_fps: Mutex<f64>,
}

// ── HTTP handlers ───────────────────────────────────────────────────────────

mod handlers;
use handlers::validate_peer_token;

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
        .route("/sdp", post(handlers::handle_offer))
        .route("/state", get(handlers::handle_connection_state))
        .route("/health", get(handlers::handle_health))
        .route("/healthz", get(handlers::handle_healthz))
        .route("/shutdown", post(handlers::handle_shutdown))
        .layer(cors)
        .with_state(state);

    Ok(app)
}

fn sdp_offer_supports_h264(offer_sdp: &str) -> bool {
    offer_sdp
        .lines()
        .any(|line| line.to_ascii_lowercase().contains("h264/90000"))
}

fn create_video_encoder(
    core_width: u32,
    core_height: u32,
    core_fps: f64,
    offer_sdp: &str,
) -> Result<GstVideoEncoder, String> {
    match config::gst_video_codec() {
        config::VideoCodecPreference::Vp8 => {
            GstVideoEncoder::new_with_codec(core_width, core_height, core_fps, VideoCodec::Vp8)
        }
        config::VideoCodecPreference::H264 => {
            if !sdp_offer_supports_h264(offer_sdp) {
                return Err(
                    "GV_GST_VIDEO_CODEC=h264 but browser offer does not include H.264".into(),
                );
            }
            GstVideoEncoder::new_with_codec(core_width, core_height, core_fps, VideoCodec::H264)
        }
        config::VideoCodecPreference::Auto => {
            if sdp_offer_supports_h264(offer_sdp) {
                match GstVideoEncoder::new_with_codec(
                    core_width,
                    core_height,
                    core_fps,
                    VideoCodec::H264,
                ) {
                    Ok(enc) => return Ok(enc),
                    Err(e) => tracing::warn!(
                        "[GST-video] H.264 auto setup failed, falling back to VP8: {e}"
                    ),
                }
            }
            GstVideoEncoder::new_with_codec(core_width, core_height, core_fps, VideoCodec::Vp8)
        }
    }
}

// ── WebRTC handshake ────────────────────────────────────────────────────────

pub(super) async fn do_webrtc_handshake(
    state: Arc<AppState>,
    offer_sdp: &str,
    peer_token: &str,
    peer_role: PeerRole,
    peer_seat: u32,
) -> Result<SdpAnswer, String> {
    // Check if this is the first peer (needs to load core + spawn stream)
    let is_first_peer = !state.core_loaded.load(Ordering::Relaxed);

    let (core_cmd_tx, selected_video_codec, _video_enc, _audio_enc, _core_fps) = if is_first_peer {
        // ── First peer: load core + create encoders ──
        let _core_guard = state.core_spawning.lock().await;
        let (w, h, fps, frame_rx, cmd_tx, response_rx, sample_rate, audio_ch) =
            match crate::core_bridge::spawn_core_thread() {
                Some(handle) => {
                    tracing::info!(
                        "[STREAM] Core: {}×{} @ {:.1}fps {:.0}Hz",
                        handle.width, handle.height, handle.fps, handle.sample_rate
                    );
                    state.core_loaded.store(true, Ordering::Relaxed);
                    (
                        handle.width,
                        handle.height,
                        handle.fps,
                        Some(handle.frame_rx),
                        Some(handle.cmd_tx),
                        Some(handle.response_rx),
                        Some(handle.sample_rate),
                        handle.audio_channels as usize,
                    )
                }
                None => {
                    return Err("no libretro core available".into());
                }
            };

        let video_encoder = create_video_encoder(w, h, fps, offer_sdp)
            .map_err(|e| format!("video encoder: {e}"))?;
        let selected = video_encoder.codec();
        let venc = Arc::new(tokio::sync::Mutex::new(video_encoder));

        let aenc: Arc<tokio::sync::Mutex<Option<GstAudioEncoder>>> =
            Arc::new(tokio::sync::Mutex::new(match sample_rate {
                Some(rate) => match GstAudioEncoder::new(rate, audio_ch as u16) {
                    Ok(enc) => Some(enc),
                    Err(e) => {
                        tracing::error!("[AUDIO] encoder failed: {e} — audio disabled");
                        None
                    }
                },
                None => None,
            }));

        // Store in AppState for subsequent peers
        *state.core_width.lock().await = w;
        *state.core_height.lock().await = h;
        *state.core_fps.lock().await = fps;
        *state.video_enc.lock().await = Some(venc.clone());
        *state.audio_enc.lock().await = Some(aenc.clone());
        *state.core_cmd_tx.lock().await = cmd_tx.clone();
        *state.core_frame_rx.lock().await = frame_rx;
        *state.core_response_rx.lock().await = response_rx;

        (cmd_tx, selected, venc, aenc, fps)
    } else {
        // ── Subsequent peer: reuse existing core + encoders ──
        let cmd_tx = state.core_cmd_tx.lock().await.clone();
        let venc = state
            .video_enc
            .lock()
            .await
            .clone()
            .ok_or("video encoder not available")?;
        let aenc = state
            .audio_enc
            .lock()
            .await
            .clone()
            .ok_or("audio encoder not available")?;
        let fps = *state.core_fps.lock().await;

        // Determine codec from what was created
        let selected = venc.lock().await.codec();

        (cmd_tx, selected, venc, aenc, fps)
    };

    // Reconnect semantics: one live PeerConnection per peer_token.
    // Browser retries create a fresh ICE ufrag; keeping the old PC alive makes
    // webrtc-rs reject the new checks as ErrMismatchUsername against the old
    // remote ufrag. Close/sweep stale attempts before accepting this offer.
    {
        let mut peers = state.peers.lock().await;
        // Close existing PC for this token (reconnect: close old, accept new)
        if let Some(existing) = peers.get(peer_token) {
            let _ = existing.pc.close().await;
        }
        // Sweep Disconnected tombstones (no live PC to close)
        peers.retain(|_, p| !matches!(p.lifecycle, PeerLifecycle::Disconnected));
    }

    // ── Build WebRTC stack (per-peer) ──
    let mut media_engine = MediaEngine::default();
    media_engine
        .register_default_codecs()
        .map_err(|e| format!("register codecs: {e}"))?;

    let mut registry = webrtc::interceptor::registry::Registry::new();
    registry = register_default_interceptors(registry, &mut media_engine)
        .map_err(|e| format!("interceptors: {e}"))?;

    let mut se = SettingEngine::default();
    se.set_ip_filter(Box::new(|ip: IpAddr| ip.is_ipv4()));
    se.set_network_types(vec![NetworkType::Udp4, NetworkType::Tcp4]);
    // mDNS QueryOnly: worker sends REAL LAN IPs as host candidates (not .local),
    // but still resolves remote .local candidates. This is critical for LAN guests
    // in incognito/private windows: the browser can reach the worker's real IP,
    // STUN binding request → worker discovers browser's real IP as prflx → connection.
    // QueryAndGenerate (default) makes the worker send .local too, which the guest
    // can't resolve → both sides send .local at each other → ICE fails.
    se.set_ice_multicast_dns_mode(MulticastDnsMode::QueryOnly);

    let api = APIBuilder::new()
        .with_setting_engine(se)
        .with_media_engine(media_engine)
        .with_interceptor_registry(registry)
        .build();

    let ice_cfg = ice_config();
    let ice_servers: Vec<RTCIceServer> = ice_cfg
        .servers
        .iter()
        .map(|s| RTCIceServer {
            urls: s.urls.clone(),
            username: s.username.clone().unwrap_or_default(),
            credential: s.credential.clone().unwrap_or_default(),
            ..Default::default()
        })
        .collect();
    let ice_policy = match ice_cfg.transport_policy {
        config::IceTransportPolicy::All => RTCIceTransportPolicy::All,
        config::IceTransportPolicy::Relay => RTCIceTransportPolicy::Relay,
    };

    let pc = Arc::new(
        api.new_peer_connection(RTCConfiguration {
            ice_servers,
            ice_transport_policy: ice_policy,
            ..Default::default()
        })
        .await
        .map_err(|e| format!("peer connection: {e}"))?,
    );

    // ICE gathering
    let (done_tx, mut done_rx) = tokio::sync::mpsc::channel::<()>(1);
    pc.on_ice_candidate(Box::new({
        let done_tx = done_tx.clone();
        move |candidate: Option<webrtc::ice_transport::ice_candidate::RTCIceCandidate>| {
            let done_tx = done_tx.clone();
            Box::pin(async move {
                if candidate.is_none() {
                    let _ = done_tx.try_send(());
                }
            })
        }
    }));

    // Video track — codec selected during encoder creation
    let video_track = Arc::new(TrackLocalStaticSample::new(
        RTCRtpCodecCapability {
            mime_type: match selected_video_codec {
                VideoCodec::Vp8 => MIME_TYPE_VP8,
                VideoCodec::H264 => MIME_TYPE_H264,
            }
            .to_owned(),
            clock_rate: VP8_CLOCK_RATE,
            channels: 0,
            sdp_fmtp_line: match selected_video_codec {
                VideoCodec::Vp8 => String::new(),
                VideoCodec::H264 => {
                    "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f"
                        .to_string()
                }
            },
            rtcp_feedback: vec![],
        },
        VIDEO_TRACK_ID.to_owned(),
        STREAM_ID.to_owned(),
    ));
    pc.add_track(Arc::clone(&video_track) as Arc<dyn TrackLocal + Send + Sync>)
        .await
        .map_err(|e| format!("add video track: {e}"))?;

    // Audio track
    let audio_track = Arc::new(TrackLocalStaticSample::new(
        RTCRtpCodecCapability {
            mime_type: MIME_TYPE_OPUS.to_owned(),
            clock_rate: AUDIO_SAMPLE_RATE,
            channels: AUDIO_CHANNELS,
            sdp_fmtp_line: OPUS_SDP_FMTP.to_string(),
            rtcp_feedback: vec![],
        },
        AUDIO_TRACK_ID.to_owned(),
        STREAM_ID.to_owned(),
    ));
    pc.add_track(Arc::clone(&audio_track) as Arc<dyn TrackLocal + Send + Sync>)
        .await
        .map_err(|e| format!("add audio track: {e}"))?;

    // DataChannel receive
    let (dc_tx, mut dc_rx) =
        tokio::sync::mpsc::channel::<Arc<webrtc::data_channel::RTCDataChannel>>(1);
    pc.on_data_channel(Box::new(
        move |d: Arc<webrtc::data_channel::RTCDataChannel>| {
            let tx = dc_tx.clone();
            Box::pin(async move {
                let _ = tx.send(d).await;
            })
        },
    ));

    // SDP exchange
    let offer_desc = RTCSessionDescription::offer(offer_sdp.to_string())
        .map_err(|e| format!("parse offer: {e}"))?;
    pc.set_remote_description(offer_desc)
        .await
        .map_err(|e| format!("set remote: {e}"))?;
    let answer = pc
        .create_answer(None)
        .await
        .map_err(|e| format!("create answer: {e}"))?;
    pc.set_local_description(answer)
        .await
        .map_err(|e| format!("set local: {e}"))?;

    // Wait for ICE — gatherer sends None when "done", but relay candidates
    // often arrive 0.5-2s after host/srflx. Wait an extra grace period so the
    // SDP answer includes the relay candidate. Without it, relay↔relay pairs
    // can't form and guest connections fail.
    tokio::time::timeout(
        Duration::from_secs(ICE_GATHERING_TIMEOUT_SECS),
        done_rx.recv(),
    )
    .await
    .map_err(|_| "ICE gathering timed out".to_string())?
    .ok_or("ICE cancelled".to_string())?;

    // Give late relay candidates time to populate
    tokio::time::sleep(Duration::from_secs(3)).await;

    let local_desc = pc.local_description().await.ok_or("no local desc")?;
    let answer_sdp = SdpAnswer { sdp: local_desc.sdp };

    // DataChannel auth — lifecycle-driven
    let dc_stream: Arc<tokio::sync::Mutex<Option<Arc<webrtc::data_channel::RTCDataChannel>>>> =
        Arc::new(tokio::sync::Mutex::new(None));
    let dc_stream_for_spawn = dc_stream.clone();
    let dc_state = Arc::clone(&state);
    let dc_peer_id = peer_token.to_string();
    let dc_peer_tokens = state.peer_tokens.clone();
    let dc_core_cmd = core_cmd_tx.clone();
    let dc_peer_role = peer_role;
    let dc_peer_seat = peer_seat;

    tokio::spawn(async move {
        let dc = match tokio::time::timeout(
            Duration::from_secs(DC_RECEIVE_TIMEOUT_SECS),
            dc_rx.recv(),
        )
        .await
        {
            Ok(Some(dc)) => dc,
            _ => {
                tracing::info!("[DC] no DataChannel from browser");
                // Transition to Disconnected — no DC means dead connection
                if let Some(peer) = dc_state.peers.lock().await.get_mut(&dc_peer_id) {
                    peer.lifecycle = PeerLifecycle::Disconnected;
                }
                return;
            }
        };
        *dc_stream_for_spawn.lock().await = Some(dc.clone());

        // Transition: Negotiating → Authenticating
        {
            let mut peers = dc_state.peers.lock().await;
            if let Some(peer) = peers.get_mut(&dc_peer_id) {
                peer.lifecycle = PeerLifecycle::Authenticating {
                    since: std::time::Instant::now(),
                };
            }
        }

        // Auth timeout — transition Authenticating → Disconnected if no auth message
        let auth_state = Arc::clone(&dc_state);
        let auth_peer_id = dc_peer_id.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_secs(dc_auth_timeout_secs())).await;
            let mut peers = auth_state.peers.lock().await;
            if let Some(peer) = peers.get_mut(&auth_peer_id) {
                if matches!(peer.lifecycle, PeerLifecycle::Authenticating { .. }) {
                    tracing::warn!("[DC] auth timeout for peer {:.8}", &auth_peer_id[..8]);
                    peer.lifecycle = PeerLifecycle::Disconnected;
                    let _ = peer.pc.close().await;
                }
            }
        });

        dc.on_message(Box::new({
            let dc_cmd = dc.clone();
            let dc_msg_state = Arc::clone(&dc_state);
            let dc_msg_peer_id = dc_peer_id.clone();
            move |msg| {
                let dc = dc_cmd.clone();
                let core_tx = dc_core_cmd.clone();
                let peer_tokens = dc_peer_tokens.clone();
                let seat = dc_peer_seat;
                let state = Arc::clone(&dc_msg_state);
                let pid = dc_msg_peer_id.clone();
                Box::pin(async move {
                    // Binary input (3-byte RetroArch format) — SERVER-ASSIGNED seat
                    if msg.data.len() == 3 {
                        let allowed = {
                            let peers = state.peers.lock().await;
                            peers.get(&pid)
                                .map(|p| matches!(p.lifecycle, PeerLifecycle::Active { .. }))
                                .unwrap_or(false)
                        };
                        if !allowed {
                            return;
                        }
                        let input_state = u16::from_le_bytes([msg.data[1], msg.data[2]]);
                        if let Some(ref tx) = core_tx {
                            let _ = tx.try_send(CoreCommand::SetInput {
                                port: seat,
                                state: input_state,
                            });
                        }
                        return;
                    }

                    let text = String::from_utf8_lossy(&msg.data).trim().to_string();

                    // Plain ping
                    if text == "ping" {
                        let now = std::time::SystemTime::now()
                            .duration_since(std::time::UNIX_EPOCH)
                            .unwrap_or_default()
                            .as_millis();
                        let resp = serde_json::json!({"type":"pong","server_ts_ms":now});
                        let _ = dc.send_text(&resp.to_string()).await;
                        return;
                    }

                    let cmd: serde_json::Value = match serde_json::from_str(&text) {
                        Ok(v) => v,
                        Err(_) => return,
                    };
                    let cmd_type = cmd.get("cmd").and_then(|v| v.as_str()).unwrap_or("");

                    // Auth — validate peer_token, transition to Active
                    if cmd_type == "auth" {
                        if let Some(token) = cmd.get("peer_token").and_then(|v| v.as_str()) {
                            let authorized = validate_peer_token(&peer_tokens, token).is_some();
                            let mut peers = state.peers.lock().await;
                            if let Some(peer) = peers.get_mut(&pid) {
                                if !authorized {
                                    tracing::warn!("[DC] auth failed — invalid peer_token");
                                    peer.lifecycle = PeerLifecycle::Disconnected;
                                    dc.close().await.ok();
                                } else {
                                    peer.lifecycle = PeerLifecycle::Active {
                                        role: dc_peer_role,
                                        seat: dc_peer_seat,
                                    };
                                }
                            }
                        }
                        return;
                    }

                    // JSON ping
                    if cmd_type == "ping" {
                        let seq = cmd.get("seq").and_then(|v| v.as_u64()).unwrap_or(0);
                        let now = std::time::SystemTime::now()
                            .duration_since(std::time::UNIX_EPOCH)
                            .unwrap_or_default()
                            .as_millis();
                        let resp =
                            serde_json::json!({"type":"pong","seq":seq,"server_ts_ms":now});
                        let _ = dc.send_text(&resp.to_string()).await;
                        return;
                    }

                    // Role-gated: check lifecycle for permissions
                    let (is_host, can_input) = {
                        let peers = state.peers.lock().await;
                        match peers.get(&pid).map(|p| &p.lifecycle) {
                            Some(PeerLifecycle::Active { role, .. }) => {
                                (*role == PeerRole::Host, *role == PeerRole::Host || *role == PeerRole::Player)
                            }
                            _ => (false, false),
                        }
                    };
                    if !can_input {
                        return;
                    }
                    match cmd_type {
                        "input" => {
                            if let (Some(key), Some(pressed)) = (
                                cmd.get("key").and_then(|v| v.as_str()),
                                cmd.get("pressed").and_then(|v| v.as_bool()),
                            ) {
                                if let Some(button) = map_key_to_joypad(key) {
                                    let _ = core_tx.as_ref().map(|tx| {
                                        tx.try_send(CoreCommand::SetJoypad {
                                            port: seat,
                                            button,
                                            pressed,
                                        })
                                    });
                                }
                            }
                        }
                        "force_keyframe" if is_host => {
                            tracing::info!("[DC] force_keyframe requested");
                        }
                        "save_state" | "load_state" if is_host => {
                            if let Some(slot) = cmd.get("slot").and_then(|v| v.as_u64()) {
                                let slot = slot.min(9) as u8;
                                if slot >= 1 {
                                    let cmd = if cmd_type == "save_state" {
                                        CoreCommand::SaveState { slot }
                                    } else {
                                        CoreCommand::LoadState { slot }
                                    };
                                    let _ = core_tx.as_ref().map(|tx| tx.try_send(cmd));
                                }
                            }
                        }
                        "reset" if is_host => {
                            tracing::info!("[DC] reset requested");
                            let _ = core_tx.as_ref().map(|tx| tx.try_send(CoreCommand::Reset));
                        }
                        "disk_eject" if is_host => {
                            tracing::info!("[DC] disk_eject requested");
                            let _ =
                                core_tx.as_ref().map(|tx| tx.try_send(CoreCommand::DiskEject));
                        }
                        "disk_insert" if is_host => {
                            let index =
                                cmd.get("index").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
                            tracing::info!("[DC] disk_insert index={}", index);
                            let _ = core_tx
                                .as_ref()
                                .map(|tx| tx.try_send(CoreCommand::DiskInsert { index }));
                        }
                        _ => {}
                    }
                })
            }
        }));
    });

    // Core response drain (first peer only — response_rx is single-consumer)
    if is_first_peer {
        if let Some(core_response_rx) = state.core_response_rx.lock().await.take() {
            let dc_for_resp = dc_stream.clone();
            tokio::spawn(async move {
                while let Ok(resp) = core_response_rx.recv() {
                    let json = match resp {
                        crate::core_bridge::CoreResponse::SaveStateResult { slot, ok, data } => {
                            serde_json::json!({"type":"save_state_result","slot":slot,"ok":ok,"bytes":data.len()})
                        }
                        crate::core_bridge::CoreResponse::LoadStateResult { slot, ok } => {
                            serde_json::json!({"type":"load_state_result","slot":slot,"ok":ok})
                        }
                    };
                    if let Some(dc) = dc_for_resp.lock().await.as_ref() {
                        let _ = dc.send_text(&json.to_string()).await;
                    }
                }
            });
        }
    }

    // Store peer in registry — use ACTUAL token as key (one live PC per token).
    // Stale same-token peers are closed above before the new PC is created.
    let peer_id = peer_token.to_string();
    state.peers.lock().await.insert(
        peer_id.clone(),
        PeerState {
            pc: Arc::clone(&pc),
            lifecycle: PeerLifecycle::Negotiating,
            dc_stream: dc_stream.clone(),
            video_track: Arc::clone(&video_track),
            audio_track: Arc::clone(&audio_track),
        },
    );
    tracing::info!(
        "[PEER] {:.8} registered (seat={}, role={:?})",
        peer_id,
        peer_seat,
        peer_role
    );

    // Disconnect detection — tombstone as Disconnected (don't remove — reconnect semantics)
    let disconnect_state = Arc::clone(&state);
    let disconnect_peer_id = peer_id.clone();
    pc.on_peer_connection_state_change(Box::new(move |s: RTCPeerConnectionState| {
        let state = Arc::clone(&disconnect_state);
        let pid = disconnect_peer_id.clone();
        Box::pin(async move {
            match s {
                RTCPeerConnectionState::Failed | RTCPeerConnectionState::Closed => {
                    tracing::info!(
                        "[PEER] {:.8} disconnected ({:?})",
                        &pid[..8.min(pid.len())],
                        s
                    );
                    if let Some(peer) = state.peers.lock().await.get_mut(&pid) {
                        peer.lifecycle = PeerLifecycle::Disconnected;
                    }
                }
                _ => {}
            }
        })
    }));

    // Spawn streaming loop on first peer only
    if is_first_peer {
        let stream_cancel = CancellationToken::new();
        let stream_ctx = StreamCtx {
            cancel: stream_cancel.clone(),
            app_state: Arc::clone(&state),
        };

        let handle = tokio::spawn(async move {
            stream_frames(stream_ctx).await;
        });

        {
            *state.stream_handle.lock().await = Some(handle);
            *state.cancel.lock().await = stream_cancel;
        }
    }

    // Clear destruct timer (stream is active)
    {
        let mut timer = state.destruct_timer.lock().await;
        if let Some(h) = timer.take() {
            h.abort();
        }
    }

    Ok(answer_sdp)
}

// ── Streaming loop ──────────────────────────────────────────────────────────

struct StreamCtx {
    cancel: CancellationToken,
    app_state: Arc<AppState>,
}

async fn stream_frames(ctx: StreamCtx) {
    use webrtc::media::Sample;

    let fps = *ctx.app_state.core_fps.lock().await;
    let frame_interval = Duration::from_secs_f64(1.0 / fps.max(1.0));
    let mut frame_num: u64 = 0;
    let mut audio_ts: u32 = 0;
    let mut audio_write_errs: u64 = 0;
    let mut audio_acc: Vec<i16> = Vec::new();
    let start_instant = std::time::Instant::now();

    let mut tick = tokio::time::interval(frame_interval);
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

    // Some cores (genesis_plus_gx) boot at one resolution then switch
    // to a different gameplay resolution on the first few frames.
    // Probe the first frame and rebuild the encoder if needed.
    let mut resolution_probed = false;

    tracing::info!("[STREAM] Starting GStreamer frame loop @ {:.1}fps", fps);

    loop {
        tokio::select! {
            _ = ctx.cancel.cancelled() => {
                tracing::info!("[STREAM] Cancelled");
                break;
            }
            _ = tick.tick() => {
                // ── Drain core frames ─────────────────────────
                let mut video_data: Option<(Vec<u8>, u32, u32)> = None;
                let mut audio_data: Vec<i16> = Vec::new();

                {
                    let frame_rx_guard = ctx.app_state.core_frame_rx.lock().await;
                    if let Some(ref rx) = *frame_rx_guard {
                        let mut latest = None;
                        while let Ok(f) = rx.try_recv() {
                            latest = Some(f);
                        }
                        match latest {
                            Some(f) if f.width == 0 => {
                                tracing::error!("[STREAM] Core sentinel — died");
                                break;
                            }
                            Some(f) => {
                                // ── Resolution probe (first frame only) ──
                                if !resolution_probed {
                                    resolution_probed = true;
                                    if f.width > 0 && f.height > 0 {
                                        let enc_guard = ctx.app_state.video_enc.lock().await;
                                        if let Some(ref enc_arc) = *enc_guard {
                                            let enc = enc_arc.lock().await;
                                            let enc_w = enc.width();
                                            let enc_h = enc.height();
                                            let sf = enc.scale_factor();
                                            let enc_core_w = if sf > 0 { enc_w / sf } else { enc_w };
                                            let enc_core_h = if sf > 0 { enc_h / sf } else { enc_h };
                                            if f.width != enc_core_w || f.height != enc_core_h {
                                                tracing::info!(
                                                    "[STREAM] Resolution probe: encoder {ecw}×{ech}, actual {aw}×{ah} — rebuilding",
                                                    ecw = enc_core_w, ech = enc_core_h, aw = f.width, ah = f.height,
                                                );
                                                drop(enc);
                                                let _ = enc_arc;
                                                drop(enc_guard);
                                                match GstVideoEncoder::new(f.width, f.height, fps) {
                                                    Ok(new_enc) => {
                                                        *ctx.app_state.video_enc.lock().await =
                                                            Some(Arc::new(tokio::sync::Mutex::new(new_enc)));
                                                    }
                                                    Err(e) => {
                                                        tracing::error!("[STREAM] encoder rebuild failed: {e}");
                                                        break;
                                                    }
                                                }
                                            }
                                        }
                                    }
                                }
                                video_data = Some((f.pixels, f.width, f.height));
                                audio_data = f.audio;
                            }
                            None => {
                                continue;
                            }
                        }
                    }
                }

                frame_num = frame_num.wrapping_add(1);

                // ── Push to GStreamer ─────────────────────────
                if let Some((ref pixels, w, h)) = video_data {
                    let enc_guard = ctx.app_state.video_enc.lock().await;
                    if let Some(ref enc_arc) = *enc_guard {
                        match enc_arc.lock().await.push(pixels, (w, h), frame_num) {
                            Ok(()) => {}
                            Err(e) => {
                                tracing::error!("[STREAM] video push error at frame {frame_num}: {e}");
                                break;
                            }
                        }
                    }
                }

                // ── Accumulate and push audio in 20ms chunks ──
                if !audio_data.is_empty() {
                    let aenc_guard = ctx.app_state.audio_enc.lock().await;
                    if let Some(ref aenc_arc) = *aenc_guard {
                        if let Some(ref mut enc) = *aenc_arc.lock().await {
                            let mut buf = std::mem::take(&mut audio_acc);
                            buf.extend_from_slice(&audio_data);
                            let chunk = (enc.sample_rate() as f64 * 0.02).round() as usize * enc.channels() as usize;
                            while buf.len() >= chunk {
                                let rest = buf.split_off(chunk);
                                enc.push(&buf);
                                buf = rest;
                            }
                            audio_acc = buf;
                        }
                    }
                }

                // ── Drain encoded video → fan-out to ALL peers ──
                loop {
                    let sample = {
                        let enc_guard = ctx.app_state.video_enc.lock().await;
                        match enc_guard.as_ref() {
                            Some(enc_arc) => enc_arc.lock().await.try_pull().map(|data| Sample {
                                    data: data.into(),
                                    duration: frame_interval,
                                    packet_timestamp: frame_num
                                        .wrapping_sub(1)
                                        .saturating_mul((VP8_CLOCK_RATE as f64 / fps.max(1.0)).round() as u64)
                                        as u32,
                                    ..Default::default()
                                }),
                            None => None,
                        }
                    };

                    match sample {
                        Some(ref sample) => {
                            let mut dead: Vec<String> = Vec::new();
                            {
                                let peers = ctx.app_state.peers.lock().await;
                                for (peer_id, peer) in peers.iter() {
                                    if let Err(e) = peer.video_track.write_sample(sample).await {
                                        tracing::warn!(
                                            "[STREAM] peer {:.8} video write error: {e}",
                                            peer_id
                                        );
                                        dead.push(peer_id.clone());
                                    }
                                }
                            }
                            for id in &dead {
                                ctx.app_state.peers.lock().await.remove(id);
                                tracing::info!("[STREAM] removed dead peer {:.8}", id);
                            }
                            ctx.app_state.frames_encoded.fetch_add(1, Ordering::Relaxed);
                        }
                        None => break,
                    }
                }

                // ── Drain encoded audio → fan-out to ALL peers ──
                {
                    let aenc_guard = ctx.app_state.audio_enc.lock().await;
                    if let Some(ref aenc_arc) = *aenc_guard {
                        loop {
                            let opus_data = {
                                let guard = aenc_arc.lock().await;
                                match *guard {
                                    Some(ref enc) => enc.try_pull(),
                                    None => None,
                                }
                            };
                            match opus_data {
                                Some(opus_data) => {
                                    let sample = Sample {
                                        data: opus_data.into(),
                                        duration: Duration::from_millis(20),
                                        packet_timestamp: audio_ts,
                                        ..Default::default()
                                    };
                                    audio_ts = audio_ts.wrapping_add(960);
                                    let peers = ctx.app_state.peers.lock().await;
                                    for (peer_id, peer) in peers.iter() {
                                        if let Err(e) = peer.audio_track.write_sample(&sample).await {
                                            tracing::warn!(
                                                "[STREAM] peer {:.8} audio write error: {e}",
                                                peer_id
                                            );
                                            audio_write_errs = audio_write_errs.wrapping_add(1);
                                        }
                                    }
                                }
                                None => break,
                            }
                        }
                    }
                }

                // ── Stats to all peer DataChannels ──
                if frame_num.is_multiple_of(STATS_SEND_INTERVAL) {
                    let (pushed, pulled) = {
                        let enc_guard = ctx.app_state.video_enc.lock().await;
                        match enc_guard.as_ref() {
                            Some(enc) => enc.lock().await.stats(),
                            None => (0, 0),
                        }
                    };
                    if let Ok(stats) = serde_json::to_string(&serde_json::json!({
                        "type": "stats",
                        "frame": frame_num,
                        "pipeline": {
                            "video_pushed": pushed,
                            "video_pulled": pulled,
                            "video_pending": pushed.saturating_sub(pulled),
                            "audio_write_errs": audio_write_errs,
                            "uptime_sec": start_instant.elapsed().as_secs()
                        }
                    })) {
                        let peers = ctx.app_state.peers.lock().await;
                        for (_, peer) in peers.iter() {
                            if let Some(dc) = peer.dc_stream.lock().await.as_ref() {
                                let _ = dc.send_text(&stats).await;
                            }
                        }
                    }
                }
            }
        }
    }

    tracing::info!("[STREAM] Loop exited");

    // Close all peer connections
    {
        let mut peers = ctx.app_state.peers.lock().await;
        for (_, peer) in peers.drain() {
            let _ = peer.pc.close().await;
        }
    }

    // Self-destruct timer
    {
        let exit = ctx.app_state.exit_signal.clone();
        let handle = tokio::spawn(async move {
            tokio::time::sleep(Duration::from_secs(config::WORKER_IDLE_TIMEOUT_SECS)).await;
            tracing::warn!("[SELF-DESTRUCT] idle timeout — shutting down");
            exit.cancel();
        });
        *ctx.app_state.destruct_timer.lock().await = Some(handle);
    }
}
// ── Keyboard mapping ────────────────────────────────────────────────────────

fn map_key_to_joypad(key: &str) -> Option<libretro_runner::JoypadButton> {
    use libretro_runner::JoypadButton;
    match key {
        "ArrowUp" | "w" | "W" => Some(JoypadButton::Up),
        "ArrowDown" | "s" | "S" => Some(JoypadButton::Down),
        "ArrowLeft" | "a" | "A" => Some(JoypadButton::Left),
        "ArrowRight" | "d" | "D" => Some(JoypadButton::Right),
        "Enter" | " " => Some(JoypadButton::Start),
        "Shift" => Some(JoypadButton::Select),
        "z" | "Z" => Some(JoypadButton::B),
        "x" | "X" => Some(JoypadButton::A),
        _ => None,
    }
}