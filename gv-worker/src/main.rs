mod config;
mod test_pattern;
mod vp8_encoder;

use axum::{
    extract::{Query, State},
    http::StatusCode,
    routing::{get, post},
    Json, Router,
};
use config::{
    DIAG_LOG_INTERVAL, FRAME_INTERVAL_MS, ICE_GATHERING_TIMEOUT_SECS,
    RTP_TIMESTAMP_INCREMENT, STREAM_ID, TRACK_ID,
    VIDEO_HEIGHT, VIDEO_WIDTH, VP8_CLOCK_RATE,
    stun_server,
};
use serde::{Deserialize, Serialize};
use std::net::SocketAddr;
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
            eprintln!("[SDP] handshake failed: {}", e);
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

    // ---- ICE gathering: register callback BEFORE set_local_description ----
    // Must register before calling set_local_description so we don't miss
    // the null-sentinel if ICE gathering completes synchronously.
    let (done_tx, mut done_rx) = tokio::sync::mpsc::channel::<()>(1);

    peer_connection.on_ice_candidate(Box::new({
        let done_tx = done_tx.clone();
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

    // Watch for peer disconnection — if the browser leaves, kill the stream.
    peer_connection.on_peer_connection_state_change(Box::new(
        move |s: RTCPeerConnectionState| {
            let cancel = disconnect_cancel.clone();
            Box::pin(async move {
                match s {
                    RTCPeerConnectionState::Disconnected
                    | RTCPeerConnectionState::Failed
                    | RTCPeerConnectionState::Closed => {
                        eprintln!("[STREAM] Peer {} — cancelling stream", s);
                        cancel.cancel();
                    }
                    _ => {}
                }
            })
        },
    ));

    let handle = tokio::spawn(async move {
        stream_vp8_frames(stream_track, stream_cancel).await;
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
async fn stream_vp8_frames(track: Arc<TrackLocalStaticSample>, cancel: CancellationToken) {
    use std::time::Duration;
    use webrtc::media::Sample;

    let mut encoder = match vp8_encoder::Vp8Encoder::new(VIDEO_WIDTH, VIDEO_HEIGHT) {
        Ok(e) => e,
        Err(e) => {
            eprintln!("[STREAM] Failed to create VP8 encoder: {}", e);
            return;
        }
    };

    let mut frame_num: u64 = 0;
    let frame_interval = Duration::from_millis(FRAME_INTERVAL_MS);

    // Use an interval timer for steady frame rate.
    // Skip missed ticks — if encoding takes too long, we drop frames
    // rather than queuing them up (realtime streaming priority).
    let mut tick = tokio::time::interval(frame_interval);
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

    eprintln!(
        "[STREAM] Starting VP8 frame loop ({}×{} @ {}fps, {}kbps)",
        VIDEO_WIDTH,
        VIDEO_HEIGHT,
        crate::config::VIDEO_FPS,
        crate::config::target_bitrate_kbps()
    );

    loop {
        tokio::select! {
            _ = cancel.cancelled() => {
                eprintln!("[STREAM] Cancelled");
                break;
            }
            _ = tick.tick() => {
                let pixels = test_pattern::generate_bouncing_square(VIDEO_WIDTH, VIDEO_HEIGHT, frame_num);
                frame_num = frame_num.wrapping_add(1);

                match encoder.encode(&pixels) {
                    Ok(encoded) => {
                        if frame_num <= 3 || frame_num.is_multiple_of(DIAG_LOG_INTERVAL) {
                            eprintln!("[STREAM] frame {}: encoded {} bytes", frame_num, encoded.len());
                        }
                        if encoded.is_empty() {
                            eprintln!("[STREAM] frame {}: EMPTY encoded data, skipping", frame_num);
                            continue;
                        }
                        let sample = Sample {
                            data: encoded.into(),
                            duration: frame_interval,
                            packet_timestamp: (frame_num as u32).wrapping_mul(RTP_TIMESTAMP_INCREMENT),
                            ..Default::default()
                        };
                        if let Err(e) = track.write_sample(&sample).await {
                            eprintln!("[STREAM] Write sample error at frame {}: {}", frame_num, e);
                            break;
                        }
                    }
                    Err(e) => {
                        eprintln!("[STREAM] VP8 encode error at frame {}: {}", frame_num, e);
                        break;
                    }
                }
            }
        }
    }
    eprintln!("[STREAM] Loop exited");
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
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    let app = Router::new()
        .route("/", get(handle_index))
        .route("/sdp", post(handle_offer))
        .route("/state", get(handle_connection_state))
        .route("/test-frame", get(handle_test_frame))
        .layer(cors)
        .with_state(state);

    let addr = SocketAddr::from(([0, 0, 0, 0], port));
    let listener = tokio::net::TcpListener::bind(addr).await?;
    let actual_port = listener.local_addr()?.port();

    println!("gv-worker listening on port {}", actual_port);
    eprintln!("WORKER_READY port={}", actual_port);
    eprintln!("open http://localhost:{}", actual_port);
    axum::serve(listener, app).await?;
    Ok(())
}
