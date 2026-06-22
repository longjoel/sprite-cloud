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
    extract::State,
    http::{header, HeaderMap, StatusCode},
    routing::{get, post},
    Json, Router,
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
use crate::core_bridge::CoreCommand;
use crate::gst_audio::GstAudioEncoder;
use crate::gst_video::{GstVideoEncoder, VideoCodec};

// ── Types ───────────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
struct SdpOffer {
    sdp: String,
    #[serde(default)]
    host_token: Option<String>,
}

#[derive(Debug, Serialize)]
struct SdpAnswer {
    sdp: String,
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum PeerRole {
    Host,
    Viewer,
}

struct AppState {
    cancel: Mutex<CancellationToken>,
    stream_handle: Mutex<Option<JoinHandle<()>>>,
    peer_connection: Mutex<Option<Arc<RTCPeerConnection>>>,
    host_token: Mutex<Option<String>>,
    control_token: Option<String>,
    exit_signal: CancellationToken,
    destruct_timer: Mutex<Option<JoinHandle<()>>>,
    core_loaded: AtomicBool,
    frames_encoded: AtomicU64,
    // ── Shared session state (extracted from do_webrtc_handshake) ──
    session_active: AtomicBool,
    video_enc: Mutex<Option<Arc<tokio::sync::Mutex<GstVideoEncoder>>>>,
    audio_enc: Mutex<Option<Arc<tokio::sync::Mutex<Option<GstAudioEncoder>>>>>,
    core_width: Mutex<u32>,
    core_height: Mutex<u32>,
    core_fps: Mutex<f64>,
}

// ── HTTP handlers ───────────────────────────────────────────────────────────

fn require_control_token(state: &AppState, headers: &HeaderMap) -> Result<(), StatusCode> {
    let Some(expected) = state.control_token.as_deref() else {
        return Ok(());
    };
    let Some(value) = headers.get(header::AUTHORIZATION) else {
        tracing::warn!("[AUTH] missing worker control token");
        return Err(StatusCode::UNAUTHORIZED);
    };
    let Ok(value) = value.to_str() else {
        return Err(StatusCode::UNAUTHORIZED);
    };
    let Some(token) = value.strip_prefix("Bearer ") else {
        return Err(StatusCode::UNAUTHORIZED);
    };
    if token == expected {
        Ok(())
    } else {
        tracing::warn!("[AUTH] bad worker control token");
        Err(StatusCode::UNAUTHORIZED)
    }
}

fn apply_sdp_host_token(host_token: &mut Option<String>, offered: Option<&str>) {
    let Some(token) = offered else { return };
    if host_token.as_deref() != Some(token) {
        tracing::info!("[SDP] host token updated");
        *host_token = Some(token.to_string());
    }
}

fn binary_input_allowed(role: Option<PeerRole>) -> bool {
    role == Some(PeerRole::Host)
}

async fn handle_offer(
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
    Json(offer): Json<SdpOffer>,
) -> Result<Json<SdpAnswer>, (StatusCode, String)> {
    require_control_token(&state, &headers).map_err(|s| (s, "unauthorized".into()))?;
    if offer.sdp.is_empty() {
        return Err((StatusCode::BAD_REQUEST, "empty SDP".into()));
    }
    if let Some(ref token) = offer.host_token {
        let mut host = state.host_token.lock().await;
        apply_sdp_host_token(&mut host, Some(token));
    }
    do_webrtc_handshake(state, &offer.sdp)
        .await
        .map(Json)
        .map_err(|e| {
            tracing::error!("[SDP] handshake failed: {e}");
            (StatusCode::INTERNAL_SERVER_ERROR, e)
        })
}

async fn handle_connection_state(
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    require_control_token(&state, &headers)?;
    let pc = state.peer_connection.lock().await;
    let s = pc
        .as_ref()
        .map(|pc| format!("{:?}", pc.connection_state()))
        .unwrap_or_else(|| "no connection".into());
    Ok(Json(serde_json::json!({"state": s})))
}

async fn handle_health(State(state): State<Arc<AppState>>) -> Json<serde_json::Value> {
    Json(serde_json::json!({
        "status": "ok",
        "core": state.core_loaded.load(Ordering::Relaxed),
        "frames": state.frames_encoded.load(Ordering::Relaxed),
    }))
}

async fn handle_healthz() -> StatusCode {
    StatusCode::OK
}

async fn handle_shutdown(
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
) -> Result<StatusCode, StatusCode> {
    require_control_token(&state, &headers)?;
    tracing::info!("[SHUTDOWN] graceful shutdown requested");
    state.exit_signal.cancel();
    Ok(StatusCode::OK)
}

async fn handle_root() -> impl axum::response::IntoResponse {
    (
        StatusCode::OK,
        axum::response::Json(serde_json::json!({"status": "ok", "service": "gv-worker"})),
    )
}

// ── App builder ─────────────────────────────────────────────────────────────

pub async fn build_app() -> Result<Router, Box<dyn std::error::Error>> {
    let host_token = config::host_token_from_env();
    let control_token = config::worker_control_token();
    if control_token.is_some() {
        tracing::info!("[STARTUP] worker control token required for HTTP control endpoints");
    }

    let state = Arc::new(AppState {
        cancel: Mutex::new(CancellationToken::new()),
        stream_handle: Mutex::new(None),
        peer_connection: Mutex::new(None),
        host_token: Mutex::new(host_token),
        control_token,
        exit_signal: CancellationToken::new(),
        destruct_timer: Mutex::new(None),
        core_loaded: AtomicBool::new(false),
        frames_encoded: AtomicU64::new(0),
        session_active: AtomicBool::new(false),
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
        .route("/", get(handle_root))
        .route("/sdp", post(handle_offer))
        .route("/state", get(handle_connection_state))
        .route("/health", get(handle_health))
        .route("/healthz", get(handle_healthz))
        .route("/shutdown", post(handle_shutdown))
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

async fn do_webrtc_handshake(state: Arc<AppState>, offer_sdp: &str) -> Result<SdpAnswer, String> {
    // Cancel previous session
    let cancel = {
        let old = state.cancel.lock().await;
        old.cancel();
        CancellationToken::new()
    };
    {
        let mut h = state.stream_handle.lock().await;
        if let Some(handle) = h.take() {
            handle.abort();
        }
    }

    // Build WebRTC stack
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

    // Load libretro core + create encoders — fresh each handshake.
    // AppState stores current values for health/monitoring.
    // Task 7 (#415) will make encoders truly shared across peers.
    let (core_width, core_height, core_fps, core_frame_rx, core_cmd_tx, core_response_rx, core_sample_rate, core_audio_channels, selected_video_codec, video_enc, audio_enc) =
    {
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

        // Store current values in AppState for health/monitoring
        *state.core_width.lock().await = w;
        *state.core_height.lock().await = h;
        *state.core_fps.lock().await = fps;
        *state.video_enc.lock().await = Some(venc.clone());
        *state.audio_enc.lock().await = Some(aenc.clone());

        (w, h, fps, frame_rx, cmd_tx, response_rx, sample_rate, audio_ch, selected, venc, aenc)
    };

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

    // Wait for ICE
    tokio::time::timeout(
        Duration::from_secs(ICE_GATHERING_TIMEOUT_SECS),
        done_rx.recv(),
    )
    .await
    .map_err(|_| "ICE gathering timed out".to_string())?
    .ok_or("ICE cancelled".to_string())?;

    let local_desc = pc.local_description().await.ok_or("no local desc")?;
    let answer_sdp = SdpAnswer { sdp: local_desc.sdp };

    // DataChannel auth
    let dc_stream: Arc<tokio::sync::Mutex<Option<Arc<webrtc::data_channel::RTCDataChannel>>>> =
        Arc::new(tokio::sync::Mutex::new(None));
    let dc_stream_for_spawn = dc_stream.clone(); // clone before move
    let dc_host_token = { state.host_token.lock().await.clone() };
    let dc_core_cmd = core_cmd_tx.clone();

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
                return;
            }
        };
        *dc_stream_for_spawn.lock().await = Some(dc.clone());

        let role: Arc<tokio::sync::Mutex<Option<PeerRole>>> =
            Arc::new(tokio::sync::Mutex::new(None));

        // Auth timeout
        let dc_to = dc.clone();
        let role_to = role.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_secs(dc_auth_timeout_secs())).await;
            if role_to.lock().await.is_none() {
                tracing::warn!("[DC] auth timeout — closing");
                dc_to.close().await.ok();
            }
        });
        dc.on_message(Box::new({
            let dc_cmd = dc.clone();
            move |msg| {
            let dc = dc_cmd.clone();
            let role = role.clone();
            let core_tx = dc_core_cmd.clone();
            let session_token = dc_host_token.clone();
            Box::pin(async move {
                // Binary input (3-byte RetroArch format)
                if msg.data.len() == 3 {
                    let port = msg.data[0] as u32;
                    if !binary_input_allowed(*role.lock().await) {
                        return;
                    }
                    let state = u16::from_le_bytes([msg.data[1], msg.data[2]]);
                    if let Some(ref tx) = core_tx {
                        let _ = tx.try_send(CoreCommand::SetInput { port, state });
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

                // Auth
                if cmd_type == "auth" {
                    if let Some(token) = cmd.get("host_token").and_then(|v| v.as_str()) {
                        let is_host = session_token.as_deref() == Some(token);
                        *role.lock().await = Some(if is_host { PeerRole::Host } else { PeerRole::Viewer });
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
                    let resp = serde_json::json!({"type":"pong","seq":seq,"server_ts_ms":now});
                    let _ = dc.send_text(&resp.to_string()).await;
                    return;
                }

                // Host-gated commands
                if *role.lock().await != Some(PeerRole::Host) {
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
                                        port: cmd.get("port").and_then(|v| v.as_u64()).unwrap_or(0) as u32,
                                        button,
                                        pressed,
                                    })
                                });
                            }
                        }
                    }
                    "force_keyframe" => {
                        tracing::info!("[DC] force_keyframe requested");
                        // GStreamer vp8enc handles keyframes via keyframe-max-dist internally
                    }
                    "save_state" | "load_state" => {
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
                    "reset" => {
                        tracing::info!("[DC] reset requested");
                        let _ = core_tx.as_ref().map(|tx| tx.try_send(CoreCommand::Reset));
                    }
                    "disk_eject" => {
                        tracing::info!("[DC] disk_eject requested");
                        let _ = core_tx.as_ref().map(|tx| tx.try_send(CoreCommand::DiskEject));
                    }
                    "disk_insert" => {
                        let index = cmd.get("index").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
                        tracing::info!("[DC] disk_insert index={}", index);
                        let _ = core_tx.as_ref().map(|tx| tx.try_send(CoreCommand::DiskInsert { index }));
                    }
                    _ => {}
                }
            })
        }
    }));
    });

    // Core response drain
    if let Some(core_response_rx) = core_response_rx {
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

    // Store state
    {
        *state.peer_connection.lock().await = Some(Arc::clone(&pc));
    }
    {
        let mut timer = state.destruct_timer.lock().await;
        if let Some(h) = timer.take() {
            h.abort();
        }
    }

    // Disconnect detection
    let disconnect_cancel = cancel.clone();
    pc.on_peer_connection_state_change(Box::new(move |s: RTCPeerConnectionState| {
        let c = disconnect_cancel.clone();
        Box::pin(async move {
            match s {
                RTCPeerConnectionState::Failed | RTCPeerConnectionState::Closed => {
                    tracing::info!("[STREAM] Peer {s:?} — cancelling");
                    c.cancel();
                }
                _ => {}
            }
        })
    }));

    // Spawn streaming task
    let stream_ctx = StreamCtx {
        track: video_track,
        audio_track,
        dc_stream,
        cancel: cancel.clone(),
        peer_connection: Arc::clone(&pc),
        app_state: Arc::clone(&state),
        video_enc,
        audio_enc,
        core_frame_rx,
        fps: core_fps,
    };

    let handle = tokio::spawn(async move {
        stream_frames(stream_ctx).await;
    });

    {
        *state.stream_handle.lock().await = Some(handle);
        *state.cancel.lock().await = cancel;
    }

    Ok(answer_sdp)
}

// ── Streaming loop ──────────────────────────────────────────────────────────

struct StreamCtx {
    track: Arc<TrackLocalStaticSample>,
    audio_track: Arc<TrackLocalStaticSample>,
    dc_stream: Arc<tokio::sync::Mutex<Option<Arc<webrtc::data_channel::RTCDataChannel>>>>,
    cancel: CancellationToken,
    peer_connection: Arc<RTCPeerConnection>,
    app_state: Arc<AppState>,
    video_enc: Arc<tokio::sync::Mutex<GstVideoEncoder>>,
    audio_enc: Arc<tokio::sync::Mutex<Option<GstAudioEncoder>>>,
    core_frame_rx: Option<std::sync::mpsc::Receiver<crate::core_bridge::CoreFrame>>,
    fps: f64,
}

async fn stream_frames(ctx: StreamCtx) {
    use webrtc::media::Sample;

    let frame_interval = Duration::from_secs_f64(1.0 / ctx.fps.max(1.0));
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

    tracing::info!("[STREAM] Starting GStreamer frame loop @ {:.1}fps", ctx.fps);

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

                if let Some(ref rx) = ctx.core_frame_rx {
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
                            // Genesis etc. boot at one resolution, play at another.
                            // Rebuild the encoder with actual dimensions on first frame.
                            if !resolution_probed {
                                resolution_probed = true;
                                if f.width > 0 && f.height > 0 {
                                    let enc = ctx.video_enc.lock().await;
                                    let enc_w = enc.width();
                                    let enc_h = enc.height();
                                    // width/height on encoder are output dims; compute core dims
                                    let sf = enc.scale_factor();
                                    let enc_core_w = if sf > 0 { enc_w / sf } else { enc_w };
                                    let enc_core_h = if sf > 0 { enc_h / sf } else { enc_h };
                                    if f.width != enc_core_w || f.height != enc_core_h {
                                        tracing::info!(
                                            "[STREAM] Resolution probe: encoder {ecw}×{ech}, actual {aw}×{ah} — rebuilding",
                                            ecw = enc_core_w, ech = enc_core_h, aw = f.width, ah = f.height,
                                        );
                                        drop(enc);
                                        match GstVideoEncoder::new(f.width, f.height, ctx.fps) {
                                            Ok(new_enc) => {
                                                *ctx.video_enc.lock().await = new_enc;
                                            }
                                            Err(e) => {
                                                tracing::error!("[STREAM] encoder rebuild failed: {e}");
                                                break;
                                            }
                                        }
                                    }
                                }
                            }
                            video_data = Some((f.pixels, f.width, f.height));
                            audio_data = f.audio;
                        }
                        None => {
                            // No frame yet, skip tick
                            continue;
                        }
                    }
                };

                frame_num = frame_num.wrapping_add(1);

                // ── Push to GStreamer ─────────────────────────
                if let Some((ref pixels, w, h)) = video_data {
                    match ctx.video_enc.lock().await.push(pixels, (w, h), frame_num) {
                        Ok(()) => {}
                        Err(e) => {
                            tracing::error!("[STREAM] video push error at frame {frame_num}: {e}");
                            break;
                        }
                    }
                }

                // ── Accumulate and push audio in 20ms chunks ──
                // opusenc with frame-size=20 needs exactly 960 samples
                // at 48kHz to emit one Opus frame. Pushing smaller
                // chunks causes internal buffering → latency spikes.
                if !audio_data.is_empty() {
                    if let Some(ref mut enc) = *ctx.audio_enc.lock().await {
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

                // ── Drain all encoded video ──────────────────
                // GStreamer pipelines are async — by the time we push frame N,
                // frame N-1 (or earlier) may have finished encoding.
                // Drain everything available, don't leave frames in the sink.
                loop {
                    match ctx.video_enc.lock().await.try_pull() {
                        Some(vp8_data) => {
                            let sample = Sample {
                                data: vp8_data.into(),
                                duration: frame_interval,
                                packet_timestamp: frame_num
                                    .wrapping_sub(1)
                                    .saturating_mul((VP8_CLOCK_RATE as f64 / ctx.fps.max(1.0)).round() as u64)
                                    as u32,
                                ..Default::default()
                            };
                            if let Err(e) = ctx.track.write_sample(&sample).await {
                                tracing::error!("[STREAM] video write error: {e}");
                                break;
                            }
                            ctx.app_state.frames_encoded.fetch_add(1, Ordering::Relaxed);
                        }
                        None => break,
                    }
                }

                // ── Pull encoded audio ────────────────────────
                if let Some(ref enc) = *ctx.audio_enc.lock().await {
                    loop {
                        match enc.try_pull() {
                            Some(opus_data) => {
                                let sample = Sample {
                                    data: opus_data.into(),
                                    duration: Duration::from_millis(20),
                                    packet_timestamp: audio_ts,
                                    ..Default::default()
                                };
                                audio_ts = audio_ts.wrapping_add(960);
                                if let Err(e) = ctx.audio_track.write_sample(&sample).await {
                                    tracing::error!("[STREAM] audio write error: {e}");
                                    audio_write_errs = audio_write_errs.wrapping_add(1);
                                }
                            }
                            None => break,
                        }
                    }
                }

                if frame_num % STATS_SEND_INTERVAL == 0 {
                    let (pushed, pulled) = ctx.video_enc.lock().await.stats();
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
                        if let Some(dc) = ctx.dc_stream.lock().await.as_ref() {
                            let _ = dc.send_text(&stats).await;
                        }
                    }
                }
            }
        }
    }

    tracing::info!("[STREAM] Loop exited");

    let _ = ctx.peer_connection.close().await;
    *ctx.app_state.peer_connection.lock().await = None;

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
