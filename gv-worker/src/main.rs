mod config;
mod core_bridge;
mod saves;
mod test_pattern;
mod test_tone;
mod vp8_encoder;

use axum::{
    extract::{Query, State},
    http::StatusCode,
    routing::{get, post},
    Json, Router,
};
use core_bridge::CoreCommand;
use config::{
    AUDIO_CHANNELS, AUDIO_RTP_TIMESTAMP_INCREMENT, AUDIO_SAMPLE_RATE,
    AUDIO_TRACK_ID, DC_RECEIVE_TIMEOUT_SECS, DIAG_LOG_INTERVAL, FRAME_INTERVAL_MS,
    ICE_GATHERING_TIMEOUT_SECS, OPUS_MAX_FRAME_BYTES, OPUS_SDP_FMTP,
    PATTERN_BARS, PATTERN_SQUARE, RTP_TIMESTAMP_INCREMENT, STATS_SEND_INTERVAL,
    STREAM_ID, TRACK_ID, VIDEO_HEIGHT, VIDEO_WIDTH, VP8_CLOCK_RATE,
    stun_server,
};
use serde::{Deserialize, Serialize};
use std::net::SocketAddr;
use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
use std::sync::Arc;
use tokio::sync::Mutex;
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;
use webrtc::api::interceptor_registry::register_default_interceptors;
use webrtc::api::media_engine::{MediaEngine, MIME_TYPE_VP8};
use webrtc::api::APIBuilder;
use webrtc::ice_transport::ice_server::RTCIceServer;
use webrtc::peer_connection::configuration::RTCConfiguration;
use webrtc::peer_connection::peer_connection_state::RTCPeerConnectionState;
use webrtc::peer_connection::sdp::session_description::RTCSessionDescription;
use webrtc::peer_connection::RTCPeerConnection;
use webrtc::rtp_transceiver::rtp_codec::RTCRtpCodecCapability;
use webrtc::track::track_local::track_local_static_sample::TrackLocalStaticSample;
use webrtc::track::track_local::TrackLocal;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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

/// Role assigned to a DataChannel peer after auth.
#[derive(Debug, Clone, Copy, PartialEq)]
enum PeerRole {
    Host,
    Viewer,
}

#[derive(Deserialize, Default)]
struct FrameQuery {
    frame: Option<u64>,
}

/// Shared state across all HTTP handlers.
struct AppState {
    /// Cancelled when a new WebRTC session starts — signals the old
    /// streaming task to shut down.
    cancel: Mutex<CancellationToken>,
    /// Handle to the currently-running streaming task, if any.
    /// Dropped/awaited when a new session replaces it.
    stream_handle: Mutex<Option<JoinHandle<()>>>,
    /// The active peer connection (for status queries).
    peer_connection: Mutex<Option<Arc<RTCPeerConnection>>>,
    /// Host token for the session — set from the first SDP offer that
    /// carries it, or from the GV_HOST_TOKEN env var.  Only the peer
    /// that presents this token gets full permissions (save, load, etc.).
    host_token: Mutex<Option<String>>,
}

// ---------------------------------------------------------------------------
// HTTP handlers
// ---------------------------------------------------------------------------

/// POST /sdp — WebRTC SDP offer/answer exchange.
///
/// Cancels any previous streaming session, negotiates a new peer
/// connection, and spawns a VP8 frame stream.
///
/// Returns HTTP 200 with SDP answer on success, 400 on bad request,
/// or 500 on internal errors.
async fn handle_offer(
    State(state): State<Arc<AppState>>,
    Json(offer): Json<SdpOffer>,
) -> Result<Json<SdpAnswer>, (StatusCode, String)> {
    if offer.sdp.is_empty() {
        return Err((StatusCode::BAD_REQUEST, "empty SDP offer".into()));
    }

    // Store the host token if this offer carries one
    if let Some(ref token) = offer.host_token {
        let mut host = state.host_token.lock().await;
        if host.is_none() {
            tracing::info!("[SDP] host token set (first offer with token)");
        }
        *host = Some(token.clone());
    }

    do_webrtc_handshake(state, &offer.sdp)
        .await
        .map(Json)
        .map_err(|e| {
            tracing::error!("[SDP] handshake failed: {}", e);
            (StatusCode::INTERNAL_SERVER_ERROR, e)
        })
}

/// GET /state — current peer connection state (for debugging).
async fn handle_connection_state(
    State(state): State<Arc<AppState>>,
) -> Json<serde_json::Value> {
    let pc_lock = state.peer_connection.lock().await;
    let state_str = pc_lock
        .as_ref()
        .map(|pc| format!("{:?}", pc.connection_state()))
        .unwrap_or_else(|| "no connection".to_string());
    Json(serde_json::json!({"state": state_str}))
}

/// GET /test-frame?frame=N — raw RGB24 frame for HTTP polling.
async fn handle_test_frame(Query(q): Query<FrameQuery>) -> axum::body::Bytes {
    let frame = q.frame.unwrap_or(0);
    axum::body::Bytes::from(test_pattern::generate_bouncing_square(
        VIDEO_WIDTH,
        VIDEO_HEIGHT,
        frame,
    ))
}

/// GET /health — liveness check.
///
/// Returns 200 OK when the HTTP server is ready.  gv-server probes this
/// after reading WORKER_READY before notifying gv-web that the worker is
/// available.
async fn handle_health() -> StatusCode {
    StatusCode::OK
}

/// GET / — embedded test page.
///
/// Deprecated: use gv-web production player at /play/:game_id instead.
/// Kept for local dev smoke testing only.
async fn handle_index() -> axum::response::Html<String> {
    axum::response::Html(build_index_html())
}

// ---------------------------------------------------------------------------
// WebRTC handshake
// ---------------------------------------------------------------------------

/// ICE_GATHERING_TIMEOUT_SECS is defined in crate::config.
async fn do_webrtc_handshake(
    state: Arc<AppState>,
    offer_sdp: &str,
) -> Result<SdpAnswer, String> {
    // ---- Cancel any previous streaming session ----
    let cancel = {
        let old_cancel = state.cancel.lock().await;
        old_cancel.cancel();
        // Create a fresh token for the new session
        CancellationToken::new()
    };

    // Drop the old stream handle (tokio will cancel the task on drop
    // if it hasn't already, but we prefer the CancellationToken path)
    {
        let mut handle_lock = state.stream_handle.lock().await;
        if let Some(handle) = handle_lock.take() {
            handle.abort();
        }
    }

    // ---- Build WebRTC stack ----
    let mut media_engine = MediaEngine::default();
    media_engine
        .register_default_codecs()
        .map_err(|e| format!("register codecs: {}", e))?;

    let mut registry = webrtc::interceptor::registry::Registry::new();
    registry = register_default_interceptors(registry, &mut media_engine)
        .map_err(|e| format!("register interceptors: {}", e))?;

    let api = APIBuilder::new()
        .with_media_engine(media_engine)
        .with_interceptor_registry(registry)
        .build();

    let config = RTCConfiguration {
        ice_servers: vec![RTCIceServer {
            urls: vec![stun_server().to_string()],
            ..Default::default()
        }],
        ..Default::default()
    };

    let peer_connection = Arc::new(
        api.new_peer_connection(config)
            .await
            .map_err(|e| format!("create peer connection: {}", e))?,
    );

    // ---- Load libretro core (or fall back to test pattern) ----//
    let (enc_width, enc_height, core_frame_rx, core_cmd_tx, core_response_rx) =
        match core_bridge::spawn_core_thread() {
            Some(handle) => {
                tracing::info!(
                    "[STREAM] Using libretro core at {}×{}",
                    handle.width, handle.height
                );
                (
                    handle.width,
                    handle.height,
                    Some(handle.frame_rx),
                    Some(handle.cmd_tx),
                    Some(handle.response_rx),
                )
            }
            None => {
                tracing::info!(
                    "[STREAM] Core not available — using test pattern at {}×{}",
                    VIDEO_WIDTH, VIDEO_HEIGHT
                );
                (VIDEO_WIDTH, VIDEO_HEIGHT, None, None, None)
            }
        };

    // ---- Create encoder + shared state ----
    let encoder_mutex: Arc<std::sync::Mutex<vp8_encoder::Vp8Encoder>> =
        Arc::new(std::sync::Mutex::new(
            vp8_encoder::Vp8Encoder::new(enc_width, enc_height)
                .map_err(|e| format!("create VP8 encoder: {}", e))?,
        ));
    let force_keyframe = Arc::new(AtomicBool::new(false));
    let pattern = Arc::new(AtomicU8::new(PATTERN_SQUARE));

    // ---- ICE gathering: register callback BEFORE set_local_description ----
    // Must register before calling set_local_description so we don't miss
    // the null-sentinel if ICE gathering completes synchronously.
    let (done_tx, mut done_rx) = tokio::sync::mpsc::channel::<()>(1);

    peer_connection.on_ice_candidate(Box::new({
        move |candidate: Option<webrtc::ice_transport::ice_candidate::RTCIceCandidate>| {
            let done_tx = done_tx.clone();
            Box::pin(async move {
                if candidate.is_none() {
                    // null candidate = ICE gathering complete
                    let _ = done_tx.try_send(());
                }
            })
        }
    }));

    // ---- Create video track ----
    let video_track = Arc::new(TrackLocalStaticSample::new(
        RTCRtpCodecCapability {
            mime_type: MIME_TYPE_VP8.to_owned(),
            clock_rate: VP8_CLOCK_RATE,
            channels: 0,
            sdp_fmtp_line: String::new(),
            rtcp_feedback: vec![],
        },
        TRACK_ID.to_owned(),
        STREAM_ID.to_owned(),
    ));

    peer_connection
        .add_track(Arc::clone(&video_track) as Arc<dyn TrackLocal + Send + Sync>)
        .await
        .map_err(|e| format!("add track: {}", e))?;

    // ---- Create audio track ----
    let audio_track = Arc::new(TrackLocalStaticSample::new(
        RTCRtpCodecCapability {
            mime_type: webrtc::api::media_engine::MIME_TYPE_OPUS.to_owned(),
            clock_rate: AUDIO_SAMPLE_RATE,
            channels: AUDIO_CHANNELS,
            sdp_fmtp_line: OPUS_SDP_FMTP.to_string(),
            rtcp_feedback: vec![],
        },
        AUDIO_TRACK_ID.to_owned(),
        STREAM_ID.to_owned(),
    ));

    peer_connection
        .add_track(Arc::clone(&audio_track) as Arc<dyn TrackLocal + Send + Sync>)
        .await
        .map_err(|e| format!("add audio track: {}", e))?;

    // ---- Receive DataChannel from browser (offerer creates it) ----
    // The browser creates the "diagnostics" DataChannel in its offer.
    // We receive it here and set up the message handler.
    let (dc_tx, mut dc_rx) = tokio::sync::mpsc::channel::<Arc<webrtc::data_channel::RTCDataChannel>>(1);

    peer_connection.on_data_channel(Box::new(move |d: Arc<webrtc::data_channel::RTCDataChannel>| {
        let tx = dc_tx.clone();
        Box::pin(async move {
            if let Err(e) = tx.send(d).await {
                tracing::warn!("[DC] Failed to send DataChannel to receiver: {}", e);
            }
        })
    }));

    // ---- SDP exchange ----
    let offer_desc = RTCSessionDescription::offer(offer_sdp.to_string())
        .map_err(|e| format!("parse offer: {}", e))?;
    peer_connection
        .set_remote_description(offer_desc)
        .await
        .map_err(|e| format!("set remote: {}", e))?;

    let answer_desc = peer_connection
        .create_answer(None)
        .await
        .map_err(|e| format!("create answer: {}", e))?;
    peer_connection
        .set_local_description(answer_desc)
        .await
        .map_err(|e| format!("set local: {}", e))?;

    // ---- Wait for ICE gathering (with timeout) ----
    tokio::time::timeout(
        std::time::Duration::from_secs(ICE_GATHERING_TIMEOUT_SECS),
        done_rx.recv(),
    )
    .await
    .map_err(|_| "ICE gathering timed out".to_string())
    .map_err(|e| format!("ICE: {}", e))?
    .ok_or("ICE gathering cancelled".to_string())?;

    // ---- Get complete answer ----
    let local_desc = peer_connection
        .local_description()
        .await
        .ok_or("no local description")?;
    let answer_sdp = SdpAnswer {
        sdp: local_desc.sdp,
    };

    // ---- Spawn task to receive DataChannel from browser ----
    // The browser creates the "diagnostics" channel in its offer.
    // We receive it asynchronously — the SDP response must not wait for it.
    // The streaming loop holds a clone of dc_stream; if no DC arrives,
    // stats and control silently fail (video + audio still work).
    let dc_stream_for_loop: Arc<tokio::sync::Mutex<Option<Arc<webrtc::data_channel::RTCDataChannel>>>> =
        Arc::new(tokio::sync::Mutex::new(None));

    // Clone host token for DataChannel auth
    let dc_host_token = {
        let ht = state.host_token.lock().await;
        ht.clone()
    };

    // Clone for the DC receive task
    let dc_stream_clone = dc_stream_for_loop.clone();
    let dc_encoder = encoder_mutex.clone();
    let dc_force_kf = force_keyframe.clone();
    let dc_pattern = pattern.clone();
    let dc_core_cmd = core_cmd_tx.clone();
    tokio::spawn(async move {
        match tokio::time::timeout(
            std::time::Duration::from_secs(DC_RECEIVE_TIMEOUT_SECS),
            dc_rx.recv(),
        )
        .await
        {
            Ok(Some(dc)) => {
                tracing::info!(
                    "[DC] Received diagnostics channel, readyState={:?}, id={}",
                    dc.ready_state(),
                    dc.id()
                );

                // Store for the streaming loop
                *dc_stream_clone.lock().await = Some(dc.clone());

                // Per-DC role — None until auth, then Host or Viewer
                let role: Arc<tokio::sync::Mutex<Option<PeerRole>>> =
                    Arc::new(tokio::sync::Mutex::new(None));

                // Auth timeout: close DC if no auth within 5 seconds
                let dc_timeout = dc.clone();
                let role_timeout = role.clone();
                tokio::spawn(async move {
                    tokio::time::sleep(std::time::Duration::from_secs(5)).await;
                    if role_timeout.lock().await.is_none() {
                        tracing::warn!("[DC] auth timeout — closing channel");
                        dc_timeout.close().await.ok();
                    }
                });

                // Set up control message handler
                let dc_cmd = dc.clone();
                let dc_core = dc_core_cmd.clone();
                dc.on_message(Box::new(move |msg| {
                    let encoder = dc_encoder.clone();
                    let force_kf = dc_force_kf.clone();
                    let pat = dc_pattern.clone();
                    let dc = dc_cmd.clone();
                    let core_tx = dc_core.clone();
                    let role = role.clone();
                    let session_token = dc_host_token.clone();
                    Box::pin(async move {
                        // ── Binary input (RetroArch format) ──────────
                        // Always allowed — port byte identifies the seat.
                        if msg.data.len() == 3 {
                            let port = msg.data[0] as u32;
                            let state = u16::from_le_bytes([msg.data[1], msg.data[2]]);
                            let _ = core_tx.as_ref().map(|tx| {
                                tx.try_send(CoreCommand::SetInput { port, state })
                            });
                            return;
                        }

                        let text = String::from_utf8_lossy(&msg.data);
                        let text = text.trim();

                        // Plain "ping" (no JSON wrapper) — always allowed
                        if text == "ping" {
                            let now_ms = std::time::SystemTime::now()
                                .duration_since(std::time::UNIX_EPOCH)
                                .unwrap_or_default()
                                .as_millis();
                            let resp = serde_json::json!({
                                "type": "pong",
                                "server_ts_ms": now_ms
                            });
                            if let Err(e) = dc.send_text(&resp.to_string()).await {
                                tracing::warn!("[DC] send_text(pong) failed: {}", e);
                            }
                            return;
                        }

                        let cmd: serde_json::Value = match serde_json::from_str(text) {
                            Ok(v) => v,
                            Err(_) => return,
                        };

                        let cmd_type = cmd.get("cmd").and_then(|v| v.as_str()).unwrap_or("");

                        // ── Auth — always allowed ───────────────────
                        if cmd_type == "auth" {
                            if let Some(token) = cmd.get("host_token").and_then(|v| v.as_str()) {
                                let is_host = session_token.as_deref() == Some(token);
                                let mut r = role.lock().await;
                                *r = Some(if is_host { PeerRole::Host } else { PeerRole::Viewer });
                                tracing::info!(
                                    "[DC] peer authenticated as {:?}",
                                    r.unwrap()
                                );
                            }
                            return;
                        }

                        // ── JSON ping — always allowed ──────────────
                        if cmd_type == "ping" {
                            let seq = cmd.get("seq").and_then(|v| v.as_u64()).unwrap_or(0);
                            let now_ms = std::time::SystemTime::now()
                                .duration_since(std::time::UNIX_EPOCH)
                                .unwrap_or_default()
                                .as_millis();
                            let resp = serde_json::json!({
                                "type": "pong",
                                "seq": seq,
                                "server_ts_ms": now_ms
                            });
                            if let Err(e) = dc.send_text(&resp.to_string()).await {
                                tracing::warn!("[DC] send_text(pong seq={}) failed: {}", seq, e);
                            }
                            return;
                        }

                        // ── All other commands — role-gated ─────────
                        let current_role = *role.lock().await;
                        let is_host = current_role == Some(PeerRole::Host);

                        if !is_host {
                            tracing::warn!(
                                "[DC] viewer attempted privileged command: {} — dropping",
                                cmd_type
                            );
                            return;
                        }

                        match cmd_type {
                            "set_bitrate" => {
                                if let Some(kbps) = cmd.get("kbps").and_then(|v| v.as_u64()) {
                                    if let Ok(mut enc) = encoder.lock() {
                                        if let Err(e) = enc.set_bitrate(kbps as u32) {
                                            tracing::warn!("[DC] set_bitrate({}) failed: {}", kbps, e);
                                        } else {
                                            tracing::info!("[DC] bitrate set to {} kbps", kbps);
                                        }
                                    }
                                }
                            }
                            "set_pattern" => {
                                if let Some(p) = cmd.get("pattern").and_then(|v| v.as_str()) {
                                    let val: u8 = match p { "bars" => 1, _ => 0 };
                                    pat.store(val, Ordering::Relaxed);
                                    tracing::info!("[DC] pattern set to {}", p);
                                }
                            }
                            "input" => {
                                // Legacy JSON input — kept for backward compat, host only
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
                                force_kf.store(true, Ordering::Relaxed);
                                tracing::info!("[DC] force_keyframe requested");
                            }
                            "save_state" => {
                                if let Some(slot) = cmd.get("slot").and_then(|v| v.as_u64()) {
                                    let slot = slot.min(9) as u8;
                                    if slot >= 1 {
                                        let _ = core_tx.as_ref().map(|tx| {
                                            tx.try_send(CoreCommand::SaveState { slot })
                                        });
                                    }
                                }
                            }
                            "load_state" => {
                                if let Some(slot) = cmd.get("slot").and_then(|v| v.as_u64()) {
                                    let slot = slot.min(9) as u8;
                                    if slot >= 1 {
                                        let _ = core_tx.as_ref().map(|tx| {
                                            tx.try_send(CoreCommand::LoadState { slot })
                                        });
                                    }
                                }
                            }
                            _ => {
                                tracing::debug!("[DC] unknown command: {}", cmd_type);
                            }
                        }
                    })
                }));
            }
            Ok(None) => {
                tracing::warn!("[DC] DataChannel receive channel closed unexpectedly");
            }
            Err(_) => {
                tracing::info!("[DC] No DataChannel from browser (test offer or no DC support)");
            }
        }
    });

    // ---- Spawn task to drain core responses (save/load state results) ----//
    if let Some(core_response_rx) = core_response_rx {
        let dc_for_responses = dc_stream_for_loop.clone();
        tokio::spawn(async move {
            while let Ok(resp) = core_response_rx.recv() {
                let json = match resp {
                    core_bridge::CoreResponse::SaveStateResult { slot, ok, data } => {
                        serde_json::json!({
                            "type": "save_state_result",
                            "slot": slot,
                            "ok": ok,
                            "bytes": data.len()
                        })
                    }
                    core_bridge::CoreResponse::LoadStateResult { slot, ok } => {
                        serde_json::json!({
                            "type": "load_state_result",
                            "slot": slot,
                            "ok": ok
                        })
                    }
                };
                if let Some(dc) = dc_for_responses.lock().await.as_ref() {
                    let _ = dc.send_text(&json.to_string()).await;
                }
            }
        });
    }

    // ---- Store state ----
    {
        let mut pc_lock = state.peer_connection.lock().await;
        *pc_lock = Some(Arc::clone(&peer_connection));
    }

    // ---- Spawn streaming task ----
    let stream_track = Arc::clone(&video_track);
    let stream_cancel = cancel.clone();
    let disconnect_cancel = cancel.clone();
    let peer_connection_clone = Arc::clone(&peer_connection);
    let state_clone = Arc::clone(&state);
    let audio_track_clone = Arc::clone(&audio_track);
    let stream_encoder = encoder_mutex.clone();
    let stream_force_kf = force_keyframe.clone();
    let stream_pattern = pattern.clone();
    let stream_dc = dc_stream_for_loop.clone();
    let stream_core_rx = core_frame_rx;
    let stream_core_cmd = core_cmd_tx;

    // Watch for peer disconnection — if the browser leaves, kill the stream.
    peer_connection.on_peer_connection_state_change(Box::new(
        move |s: RTCPeerConnectionState| {
            let cancel = disconnect_cancel.clone();
            Box::pin(async move {
                match s {
                    RTCPeerConnectionState::Disconnected
                    | RTCPeerConnectionState::Failed
                    | RTCPeerConnectionState::Closed => {
                        tracing::info!("[STREAM] Peer {} — cancelling stream", s);
                        cancel.cancel();
                    }
                    _ => {}
                }
            })
        },
    ));

    let handle = tokio::spawn(async move {
        stream_vp8_frames(StreamCtx {
            track: stream_track,
            audio_track: audio_track_clone,
            dc_stream: stream_dc,
            cancel: stream_cancel,
            peer_connection: peer_connection_clone,
            app_state: state_clone,
            encoder_mutex: stream_encoder,
            force_keyframe: stream_force_kf,
            pattern: stream_pattern,
            core_frame_rx: stream_core_rx,
            core_cmd_tx: stream_core_cmd,
        }).await;
    });

    {
        let mut handle_lock = state.stream_handle.lock().await;
        *handle_lock = Some(handle);
        *state.cancel.lock().await = cancel;
    }

    Ok(answer_sdp)
}

// ---------------------------------------------------------------------------
// VP8 frame streaming
// ---------------------------------------------------------------------------

/// Stream VP8-encoded bouncing-square frames over a WebRTC track.
///
/// Runs until `cancel` is signalled (browser disconnect, new session,
/// or unrecoverable error). Uses `tokio::time::interval` for steady
/// 30 fps timing.
///
/// When the loop exits (for any reason), the peer connection is closed
/// and cleared from AppState so no zombie PC lingers.
struct StreamCtx {
    track: Arc<TrackLocalStaticSample>,
    audio_track: Arc<TrackLocalStaticSample>,
    dc_stream: Arc<tokio::sync::Mutex<Option<Arc<webrtc::data_channel::RTCDataChannel>>>>,
    cancel: CancellationToken,
    peer_connection: Arc<RTCPeerConnection>,
    app_state: Arc<AppState>,
    encoder_mutex: Arc<std::sync::Mutex<vp8_encoder::Vp8Encoder>>,
    force_keyframe: Arc<AtomicBool>,
    pattern: Arc<AtomicU8>,
    core_frame_rx: Option<std::sync::mpsc::Receiver<core_bridge::CoreFrame>>,
    #[allow(dead_code)]
    core_cmd_tx: Option<std::sync::mpsc::SyncSender<core_bridge::CoreCommand>>,
}

async fn stream_vp8_frames(ctx: StreamCtx) {
    use std::time::Duration;
    use webrtc::media::Sample;

    let mut opus_encoder = match opus::Encoder::new(
        AUDIO_SAMPLE_RATE,
        opus::Channels::Mono,
        opus::Application::Audio,
    ) {
        Ok(e) => e,
        Err(e) => {
            tracing::error!("[STREAM] Failed to create Opus encoder: {}", e);
            return;
        }
    };

    let mut frame_num: u64 = 0;
    let frame_interval = Duration::from_millis(FRAME_INTERVAL_MS);

    // Cumulative counters for pipeline health
    let mut video_drops: u64 = 0;
    let mut audio_write_errs: u64 = 0;
    let start_instant = std::time::Instant::now();

    // Use an interval timer for steady frame rate.
    // Skip missed ticks — if encoding takes too long, we drop frames
    // rather than queuing them up (realtime streaming priority).
    let mut tick = tokio::time::interval(frame_interval);
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

    tracing::info!(
        "[STREAM] Starting VP8 frame loop ({}×{} @ {}fps, {}kbps)",
        VIDEO_WIDTH,
        VIDEO_HEIGHT,
        crate::config::VIDEO_FPS,
        crate::config::target_bitrate_kbps()
    );

    loop {
        tokio::select! {
            _ = ctx.cancel.cancelled() => {
                tracing::info!("[STREAM] Cancelled");
                break;
            }
            _ = tick.tick() => {
                // ---- Check force_keyframe flag ----
                if ctx.force_keyframe.load(Ordering::Relaxed) {
                    if let Ok(mut enc) = ctx.encoder_mutex.lock() {
                        enc.force_keyframe();
                        ctx.force_keyframe.store(false, Ordering::Relaxed);
                    }
                    // If lock failed: leave flag set, retry next frame
                }

                // ---- Generate frame (core or test pattern) ----
                let pixels = if let Some(ref rx) = ctx.core_frame_rx {
                    // Drain any backlog — only keep the latest frame
                    let mut latest = None;
                    while let Ok(f) = rx.try_recv() {
                        latest = Some(f);
                    }
                    match latest {
                        Some(f) => f.pixels,
                        None => continue, // no frame available yet, skip this tick
                    }
                } else {
                    // Fall back to test pattern
                    match ctx.pattern.load(Ordering::Relaxed) {
                        PATTERN_BARS => test_pattern::generate_color_bars(VIDEO_WIDTH, VIDEO_HEIGHT, frame_num),
                        _ => test_pattern::generate_bouncing_square(VIDEO_WIDTH, VIDEO_HEIGHT, frame_num),
                    }
                };
                frame_num = frame_num.wrapping_add(1);

                let encode_start = std::time::Instant::now();
                let encode_result = match ctx.encoder_mutex.lock() {
                    Ok(mut enc) => enc.encode(&pixels),
                    Err(e) => {
                        tracing::error!("[STREAM] encoder mutex poisoned: {}", e);
                        break;
                    }
                };
                match encode_result {
                    Ok((encoded, is_keyframe)) => {
                        let encode_us = encode_start.elapsed().as_micros();
                        let byte_count = encoded.len();
                        if frame_num <= 3 || frame_num.is_multiple_of(DIAG_LOG_INTERVAL) {
                            tracing::debug!("[STREAM] frame {}: encoded {} bytes in {}μs", frame_num, byte_count, encode_us);
                        }
                        if encoded.is_empty() {
                            tracing::warn!("[STREAM] frame {}: EMPTY encoded data, skipping", frame_num);
                            video_drops = video_drops.wrapping_add(1);
                            continue;
                        }
                        let sample = Sample {
                            data: encoded.into(),
                            duration: frame_interval,
                            packet_timestamp: (frame_num as u32).wrapping_mul(RTP_TIMESTAMP_INCREMENT),
                            ..Default::default()
                        };
                        if let Err(e) = ctx.track.write_sample(&sample).await {
                            tracing::error!("[STREAM] Write sample error at frame {}: {}", frame_num, e);
                            break;
                        }

                        // ---- Encode audio ---- (before stats so we can include audio timing)
                        let tone = test_tone::generate_tone(frame_num);
                        let audio_encode_start = std::time::Instant::now();
                        let mut audio_bytes: usize = 0;
                        let mut audio_encode_us: u64 = 0;
                        match opus_encoder.encode_vec(&tone, OPUS_MAX_FRAME_BYTES) {
                            Ok(opus_data) => {
                                audio_encode_us = audio_encode_start.elapsed().as_micros() as u64;
                                audio_bytes = opus_data.len();
                                let audio_sample = Sample {
                                    data: opus_data.into(),
                                    duration: frame_interval,
                                    packet_timestamp: (frame_num as u32).wrapping_mul(AUDIO_RTP_TIMESTAMP_INCREMENT),
                                    ..Default::default()
                                };
                                if let Err(e) = ctx.audio_track.write_sample(&audio_sample).await {
                                    tracing::error!("[STREAM] Audio write error at frame {}: {}", frame_num, e);
                                    audio_write_errs = audio_write_errs.wrapping_add(1);
                                }
                            }
                            Err(e) => {
                                tracing::error!("[STREAM] Opus encode error at frame {}: {}", frame_num, e);
                            }
                        }

                        // ---- Send per-frame stats over DataChannel ----
                        if frame_num.is_multiple_of(STATS_SEND_INTERVAL) {
                            if let Ok(stats) = serde_json::to_string(&serde_json::json!({
                                "type": "stats",
                                "frame": frame_num,
                                "video": {
                                    "bytes": byte_count,
                                    "encode_us": encode_us,
                                    "keyframe": is_keyframe
                                },
                                "audio": {
                                    "bytes": audio_bytes,
                                    "encode_us": audio_encode_us
                                },
                                "pipeline": {
                                    "drops": video_drops,
                                    "audio_write_errs": audio_write_errs,
                                    "uptime_sec": start_instant.elapsed().as_secs()
                                }
                            })) {
                                if let Some(dc) = ctx.dc_stream.lock().await.as_ref() {
                                    if let Err(e) = dc.send_text(stats).await {
                                        tracing::warn!("[STREAM] DC stats send failed: {}", e);
                                    }
                                }
                            }
                        }
                    }
                    Err(e) => {
                        tracing::error!("[STREAM] VP8 encode error at frame {}: {}", frame_num, e);
                        break;
                    }
                }
            }
        }
    }
    tracing::info!("[STREAM] Loop exited");

    // Close the peer connection so it doesn't linger as a zombie
    let _ = ctx.peer_connection.close().await;
    let mut pc_lock = ctx.app_state.peer_connection.lock().await;
    *pc_lock = None;
    tracing::info!("[STREAM] Peer connection closed and removed from state");
}

// ---------------------------------------------------------------------------
// Keyboard → joypad mapping
// ---------------------------------------------------------------------------

/// Map a browser KeyboardEvent.key string to a libretro JoypadButton.
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

// ---------------------------------------------------------------------------
// Test page
// ---------------------------------------------------------------------------

fn build_index_html() -> String {
    use std::sync::LazyLock;

    static HTML: LazyLock<String> = LazyLock::new(|| {
        format!(
            r##"<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Games Vault — Test Pattern</title>
<style>
  body {{ background:#111; display:flex; flex-direction:column; align-items:center; height:100vh; margin:0; color:#ccc; font:14px monospace }}
  video, canvas {{ image-rendering:pixelated; border:1px solid #333; max-width:100vw; max-height:80vh }}
  .log {{ margin-top:8px; font-size:12px; opacity:0.7; max-width:640px; width:100%; overflow-y:auto; max-height:30vh }}
  button {{ margin:4px; padding:4px 12px; background:#333; color:#ccc; border:1px solid #555; cursor:pointer }}
  button:hover {{ background:#444 }}
</style>
</head>
<body>
<h3 style="margin:12px 0 4px">gv-worker</h3>
<canvas id="c" width="{w}" height="{h}" style="display:none"></canvas>
<video id="v" autoplay playsinline muted width="{w}" height="{h}" style="display:none"></video>
<div>
  <button onclick="testHttp()">HTTP poll</button>
  <button onclick="testWebrtc()">WebRTC test</button>
  <button onclick="stopAll()">Stop</button>
</div>
<pre class="log" id="log"></pre>
<script>
const canvas = document.getElementById("c");
const ctx = canvas.getContext("2d");
const video = document.getElementById("v");
const logEl = document.getElementById("log");
let frame = 0;
let running = false;
let pc = null;

function log(msg) {{
  logEl.textContent += msg + "\\n";
  logEl.scrollTop = logEl.scrollHeight;
}}

async function testHttp() {{
  running = true;
  canvas.style.display = "block";
  video.style.display = "none";
  log("HTTP poll started");
  tickHttp();
}}

async function tickHttp() {{
  if (!running) return;
  try {{
    const resp = await fetch("/test-frame?frame=" + frame);
    const buf = await resp.arrayBuffer();
    const raw = new Uint8ClampedArray(buf);
    const img = new ImageData({w}, {h});
    for (let i = 0; i < raw.length; i += 3) {{
      const j = (i / 3) * 4;
      img.data[j]     = raw[i];
      img.data[j + 1] = raw[i + 1];
      img.data[j + 2] = raw[i + 2];
      img.data[j + 3] = 255;
    }}
    ctx.putImageData(img, 0, 0);
    frame++;
  }} catch(e) {{ log("Error: "+e); }}
  requestAnimationFrame(tickHttp);
}}

async function testWebrtc() {{
  log("Creating RTCPeerConnection...");
  canvas.style.display = "none";
  video.style.display = "block";

  pc = new RTCPeerConnection({{
    iceServers: [{{ urls: "{stun}" }}]
  }});

  // Create DataChannel for keyboard input
  const dc = pc.createDataChannel("diagnostics");
  dc.onopen = () => log("DC open — keyboard input active");
  dc.onclose = () => log("DC closed");

  const sendKey = (key, pressed) => {{
    if (dc.readyState === "open") {{
      dc.send(JSON.stringify({{ cmd: "input", key, pressed, port: 0 }}));
    }}
  }};

  document.addEventListener("keydown", (e) => {{
    if (e.target.tagName === "BUTTON") return;
    if (["ArrowUp","ArrowDown","ArrowLeft","ArrowRight","Enter"," "].includes(e.key)) e.preventDefault();
    sendKey(e.key, true);
  }});
  document.addEventListener("keyup", (e) => sendKey(e.key, false));
  log("Keyboard listeners active — WASD/arrows to play, Z/X for A/B");

  pc.oniceconnectionstatechange = () => {{
    log("ICE state: " + pc.iceConnectionState);
  }};
  pc.onconnectionstatechange = () => {{
    log("Connection state: " + pc.connectionState);
  }};
  pc.ontrack = (e) => {{
    log("Got remote track: " + e.track.kind);
    video.srcObject = new MediaStream([e.track]);
  }};

  pc.addTransceiver("video", {{ direction: "recvonly" }});

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  log("Offer created, sending to worker...");

  const resp = await fetch("/sdp", {{
    method: "POST",
    headers: {{ "Content-Type": "application/json" }},
    body: JSON.stringify({{ sdp: offer.sdp }})
  }});
  const answer = await resp.json();
  if (!answer.sdp) {{ log("SDP ERROR: empty answer"); return; }}

  log("Answer received (" + answer.sdp.length + " chars)");
  await pc.setRemoteDescription(new RTCSessionDescription({{
    type: "answer", sdp: answer.sdp
  }}));
  log("Remote description set, waiting for ICE...");
}}

function stopAll() {{
  running = false;
  if (pc) {{ pc.close(); pc = null; }}
  canvas.style.display = "none";
  video.style.display = "none";
  log("Stopped");
}}
</script>
</body>
</html>"##,
            w = VIDEO_WIDTH,
            h = VIDEO_HEIGHT,
            stun = stun_server(),
        )
    });

    HTML.clone()
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt()
        .json()
        .with_target(false)
        .with_timer(tracing_subscriber::fmt::time::UtcTime::rfc_3339())
        .init();

    // Root span attaches a `service` field to every log line.
    let _root = tracing::info_span!("", service = "gv-worker").entered();

    let port: u16 = std::env::args()
        .nth(1)
        .and_then(|p| p.parse().ok())
        .unwrap_or(0);

    let host_token = std::env::var("GV_HOST_TOKEN").ok();

    if host_token.is_some() {
        tracing::info!("[STARTUP] host token set from GV_HOST_TOKEN env var");
    }

    let state = Arc::new(AppState {
        cancel: Mutex::new(CancellationToken::new()),
        stream_handle: Mutex::new(None),
        peer_connection: Mutex::new(None),
        host_token: Mutex::new(host_token),
    });

    let app = Router::new()
        .route("/", get(handle_index))
        .route("/sdp", post(handle_offer))
        .route("/state", get(handle_connection_state))
        .route("/test-frame", get(handle_test_frame))
        .route("/health", get(handle_health))
        .with_state(state);

    // Bind to loopback by default — gv-worker is internal-only.
    // Set GV_BIND_ADDR=0.0.0.0 for direct dev access.
    let bind_host: std::net::IpAddr = std::env::var("GV_BIND_ADDR")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(std::net::IpAddr::from([127, 0, 0, 1]));

    let addr = SocketAddr::from((bind_host, port));
    let listener = tokio::net::TcpListener::bind(addr).await?;
    let actual_port = listener.local_addr()?.port();

    tracing::info!("gv-worker listening on port {}", actual_port);
    eprintln!("WORKER_READY port={}", actual_port);
    tracing::info!("open http://localhost:{}", actual_port);
    axum::serve(listener, app).await?;
    Ok(())
}
