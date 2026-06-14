mod config;
mod test_pattern;
mod test_tone;
mod vp8_encoder;

use axum::{
    extract::{Query, State},
    http::StatusCode,
    routing::{get, post},
    Json, Router,
};
use config::{
    AUDIO_CHANNELS, AUDIO_RTP_TIMESTAMP_INCREMENT, AUDIO_SAMPLE_RATE,
    AUDIO_TRACK_ID, DIAG_LOG_INTERVAL, FRAME_INTERVAL_MS,
    ICE_GATHERING_TIMEOUT_SECS, OPUS_MAX_FRAME_BYTES, OPUS_SDP_FMTP,
    RTP_TIMESTAMP_INCREMENT, STREAM_ID, TRACK_ID,
    VIDEO_HEIGHT, VIDEO_WIDTH, VP8_CLOCK_RATE,
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
use tower_http::cors::{Any, CorsLayer};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
struct SdpOffer {
    sdp: String,
}

#[derive(Debug, Serialize)]
struct SdpAnswer {
    sdp: String,
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

/// GET / — test page with HTTP poll and WebRTC test buttons.
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

    // ---- Create DataChannel for diagnostics (stats + control) ----
    let dc = peer_connection
        .create_data_channel("diagnostics", None)
        .await
        .map_err(|e| format!("create data channel: {}", e))?;

    // Shared state between DC message handler and streaming loop
    let encoder_mutex: Arc<std::sync::Mutex<vp8_encoder::Vp8Encoder>> =
        Arc::new(std::sync::Mutex::new(
            vp8_encoder::Vp8Encoder::new(VIDEO_WIDTH, VIDEO_HEIGHT)
                .map_err(|e| format!("create VP8 encoder: {}", e))?,
        ));
    let force_keyframe = Arc::new(AtomicBool::new(false));
    let pattern = Arc::new(AtomicU8::new(0)); // 0=square, 1=bars

    // Dispatch DataChannel messages: stats are sent by the stream loop;
    // incoming messages are control commands or pings.
    {
        let dc_encoder = encoder_mutex.clone();
        let dc_force_kf = force_keyframe.clone();
        let dc_pattern = pattern.clone();
        let dc_cmd = dc.clone();
        dc.on_message(Box::new(move |msg| {
            let encoder = dc_encoder.clone();
            let force_kf = dc_force_kf.clone();
            let pat = dc_pattern.clone();
            let dc = dc_cmd.clone();
            Box::pin(async move {
                let text = String::from_utf8_lossy(&msg.data);
                let text = text.trim();

                // Legacy: raw "ping" for backward compat
                if text == "ping" {
                    let now_ms = std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_millis();
                    let resp = serde_json::json!({
                        "type": "pong",
                        "server_ts_ms": now_ms
                    });
                    let _ = dc.send_text(&resp.to_string()).await;
                    return;
                }

                // Parse JSON command
                let cmd: serde_json::Value = match serde_json::from_str(text) {
                    Ok(v) => v,
                    Err(_) => return,
                };

                match cmd.get("cmd").and_then(|v| v.as_str()) {
                    Some("set_bitrate") => {
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
                    Some("set_pattern") => {
                        if let Some(p) = cmd.get("pattern").and_then(|v| v.as_str()) {
                            let val: u8 = match p {
                                "bars" => 1,
                                _ => 0,
                            };
                            pat.store(val, Ordering::Relaxed);
                            tracing::info!("[DC] pattern set to {}", p);
                        }
                    }
                    Some("force_keyframe") => {
                        force_kf.store(true, Ordering::Relaxed);
                        tracing::info!("[DC] force_keyframe requested");
                    }
                    Some("ping") => {
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
                        let _ = dc.send_text(&resp.to_string()).await;
                    }
                    _ => {}
                }
            })
        }));
    }

    // Clone for the streaming task to send stats
    let dc_stream = dc.clone();

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

    // ---- SDP exchange ----
    let offer_desc = RTCSessionDescription::offer(offer_sdp.to_string())
        .map_err(|e| format!("parse offer: {}", e))?;
    peer_connection
        .set_remote_description(offer_desc)
        .await
        .map_err(|e| format!("set remote: {}", e))?;

    let answer = peer_connection
        .create_answer(None)
        .await
        .map_err(|e| format!("create answer: {}", e))?;
    peer_connection
        .set_local_description(answer)
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
        stream_vp8_frames(stream_track, audio_track_clone, dc_stream, stream_cancel, peer_connection_clone, state_clone, stream_encoder, stream_force_kf, stream_pattern).await;
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
async fn stream_vp8_frames(
    track: Arc<TrackLocalStaticSample>,
    audio_track: Arc<TrackLocalStaticSample>,
    dc_stream: Arc<webrtc::data_channel::RTCDataChannel>,
    cancel: CancellationToken,
    peer_connection: Arc<RTCPeerConnection>,
    app_state: Arc<AppState>,
    encoder_mutex: Arc<std::sync::Mutex<vp8_encoder::Vp8Encoder>>,
    force_keyframe: Arc<AtomicBool>,
    pattern: Arc<AtomicU8>,
) {
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
            _ = cancel.cancelled() => {
                tracing::info!("[STREAM] Cancelled");
                break;
            }
            _ = tick.tick() => {
                // ---- Check force_keyframe flag ----
                if force_keyframe.swap(false, Ordering::Relaxed) {
                    if let Ok(mut enc) = encoder_mutex.lock() {
                        enc.force_keyframe();
                    }
                }

                // ---- Generate test pattern ----
                let pixels = match pattern.load(Ordering::Relaxed) {
                    1 => test_pattern::generate_color_bars(VIDEO_WIDTH, VIDEO_HEIGHT, frame_num),
                    _ => test_pattern::generate_bouncing_square(VIDEO_WIDTH, VIDEO_HEIGHT, frame_num),
                };
                frame_num = frame_num.wrapping_add(1);

                let encode_start = std::time::Instant::now();
                let encode_result = {
                    let mut enc = encoder_mutex.lock().unwrap();
                    enc.encode(&pixels)
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
                        if let Err(e) = track.write_sample(&sample).await {
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
                                if let Err(e) = audio_track.write_sample(&audio_sample).await {
                                    tracing::error!("[STREAM] Audio write error at frame {}: {}", frame_num, e);
                                    audio_write_errs = audio_write_errs.wrapping_add(1);
                                }
                            }
                            Err(e) => {
                                tracing::error!("[STREAM] Opus encode error at frame {}: {}", frame_num, e);
                            }
                        }

                        // ---- Send per-frame stats over DataChannel ----
                        // Every 5th frame (~6 Hz) for smooth HUD updates.
                        if frame_num % 5 == 0 {
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
                                let _ = dc_stream.send_text(stats).await;
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
    let _ = peer_connection.close().await;
    let mut pc_lock = app_state.peer_connection.lock().await;
    *pc_lock = None;
    tracing::info!("[STREAM] Peer connection closed and removed from state");
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

    let state = Arc::new(AppState {
        cancel: Mutex::new(CancellationToken::new()),
        stream_handle: Mutex::new(None),
        peer_connection: Mutex::new(None),
    });

    let cors = CorsLayer::new()
        .allow_origin(
            config::allowed_origins()
                .iter()
                .map(|o| o.parse::<axum::http::HeaderValue>().expect("invalid origin"))
                .collect::<Vec<_>>(),
        )
        .allow_methods(Any)
        .allow_headers(Any);

    let app = Router::new()
        .route("/", get(handle_index))
        .route("/sdp", post(handle_offer))
        .route("/state", get(handle_connection_state))
        .route("/test-frame", get(handle_test_frame))
        .route("/health", get(handle_health))
        .layer(cors)
        .with_state(state);

    let addr = SocketAddr::from(([0, 0, 0, 0], port));
    let listener = tokio::net::TcpListener::bind(addr).await?;
    let actual_port = listener.local_addr()?.port();

    tracing::info!("gv-worker listening on port {}", actual_port);
    eprintln!("WORKER_READY port={}", actual_port);
    tracing::info!("open http://localhost:{}", actual_port);
    axum::serve(listener, app).await?;
    Ok(())
}
