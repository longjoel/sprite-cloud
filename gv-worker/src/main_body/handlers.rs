//! HTTP route handlers for the gv-worker axum server.

use std::sync::Arc;

use axum::{
    extract::State,
    http::{header, HeaderMap, StatusCode},
    Json,
};

use super::{
    AppState, PeerRole, SdpAnswer, SdpOffer,
};

/// Validate the worker control token from the Authorization header.
pub(super) fn require_control_token(state: &AppState, headers: &HeaderMap) -> Result<(), StatusCode> {
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

pub(super) fn validate_peer_token(tokens: &[crate::config::PeerToken], offered: &str) -> Option<(PeerRole, u32)> {
    tokens.iter().find(|t| t.token == offered).map(|t| {
        let role = match t.role.as_str() {
            "host" => PeerRole::Host,
            "player" => PeerRole::Player,
            _ => PeerRole::Viewer,
        };
        (role, t.seat)
    })
}


pub(super) async fn handle_offer(
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
    Json(offer): Json<SdpOffer>,
) -> Result<Json<SdpAnswer>, (StatusCode, String)> {
    // Allow control-token-less access when gv-web trusted fields (peer_role
    // + peer_seat) are present — the inline player page gets these from the
    // redirect URL which originated from gv-web's room/join (pre-validated).
    let authenticated = offer.trusted_role_seat().is_some();
    if !authenticated {
        require_control_token(&state, &headers).map_err(|s| (s, "unauthorized".into()))?;
    }
    if offer.sdp.is_empty() {
        return Err((StatusCode::BAD_REQUEST, "empty SDP".into()));
    }
    // Determine peer identity — prefer trusted role/seat from gv-web
    // (pre-validated against the peer_tokens DB), otherwise fall back
    // to token-based validation (host or pre-registered peer_tokens).
    let peer_token: String;
    let (peer_role, peer_seat) = if let Some((role, seat)) = offer.trusted_role_seat() {
        // gv-web already validated this token against the DB
        peer_token = offer.peer_token.clone().unwrap_or_default();
        (role, seat)
    } else if let Some(token) = offer.effective_token() {
        peer_token = token.to_string();
        // Try peer_tokens first; fall back to host_token (UUID from gv-web)
        if let Some((role, seat)) = validate_peer_token(&state.peer_tokens, token) {
            (role, seat)
        } else if let Some(host_tok) = crate::config::host_token_from_env() {
            if token == host_tok {
                (PeerRole::Host, 0)
            } else {
                return Err((StatusCode::UNAUTHORIZED, "invalid token".into()));
            }
        } else {
            return Err((StatusCode::UNAUTHORIZED, "invalid token".into()));
        }
    } else {
        return Err((StatusCode::UNAUTHORIZED, "missing peer_token or host_token".into()));
    };
    super::do_webrtc_handshake(state, &offer.sdp, &peer_token, peer_role, peer_seat)
        .await
        .map(Json)
        .map_err(|e| {
            tracing::error!("[SDP] handshake failed: {e}");
            (StatusCode::INTERNAL_SERVER_ERROR, e)
        })
}

pub(super) async fn handle_connection_state(
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    require_control_token(&state, &headers)?;
    let peers = state.peers.lock().await;
    let s = if peers.is_empty() {
        "no connection".into()
    } else {
        peers.values().next().map(|p| format!("{:?}", p.pc.connection_state())).unwrap_or_else(|| "unknown".into())
    };
    Ok(Json(serde_json::json!({"state": s})))
}

pub(super) async fn handle_health(State(state): State<Arc<AppState>>) -> Json<serde_json::Value> {
    let peer_count = state.peers.lock().await.len();
    Json(serde_json::json!({
        "status": "ok",
        "core": state.core_loaded.load(std::sync::atomic::Ordering::Relaxed),
        "frames": state.frames_encoded.load(std::sync::atomic::Ordering::Relaxed),
        "peers": peer_count,
    }))
}

pub(super) async fn handle_healthz() -> StatusCode {
    StatusCode::OK
}

pub(super) async fn handle_shutdown(
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
) -> Result<StatusCode, StatusCode> {
    require_control_token(&state, &headers)?;
    tracing::info!("[SHUTDOWN] graceful shutdown requested");
    state.exit_signal.cancel();
    Ok(StatusCode::OK)
}

// ── Inline player (LAN iframe) ──────────────────────────────────────────────

pub(super) async fn handle_root() -> impl axum::response::IntoResponse {
    (
        StatusCode::OK,
        axum::response::Json(serde_json::json!({"status": "ok", "service": "gv-worker"})),
    )
}

pub(super) async fn handle_player(
    axum::extract::Query(params): axum::extract::Query<std::collections::HashMap<String, String>>,
) -> impl axum::response::IntoResponse {
    let join = params.get("join").cloned().unwrap_or_default();
    let room = params.get("room").cloned().unwrap_or_default();
    let worker = params.get("worker").cloned().unwrap_or_default();

    let html = concat!(
        "<!DOCTYPE html>\n<html lang=\"en\">\n<head>\n",
        "<meta charset=\"utf-8\">\n",
        "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1,viewport-fit=cover\">\n",
        "<title>Games Vault</title>\n<style>\n",
        ":root{--gv-mahogany:#1a1410;--gv-brass:#b8964a;--gv-cream:#e8dcc8;",
        "--gv-muted:#b8a888;--gv-cyan:#00e5ff;--gv-error:#ff4d4d}\n",
        "*{margin:0;padding:0;box-sizing:border-box}\n",
        "body{background:var(--gv-mahogany);font-family:\"SF Mono\",\"Fira Code\",monospace;",
        "color:var(--gv-cream);font-size:13px;overflow:hidden;height:100vh;width:100vw}\n",
        "#stage{position:fixed;inset:0;display:flex;align-items:center;justify-content:center}\n",
        "video{width:100%;height:100%;object-fit:contain;image-rendering:pixelated;background:#000}\n",
        "#overlay{position:fixed;bottom:0;left:0;right:0;padding:12px 16px;",
        "background:linear-gradient(transparent,rgba(26,20,16,.92));",
        "display:flex;justify-content:space-between;align-items:flex-end;",
        "pointer-events:none;z-index:10}\n",
        "#status{font-size:12px;color:var(--gv-muted)}\n",
        "#status.ok{color:var(--gv-cyan)}\n",
        "#status.err{color:var(--gv-error)}\n",
        "#hint{font-size:10px;color:var(--gv-muted);opacity:.5;text-align:right}\n",
        "</style>\n</head>\n<body>\n",
        "<div id=\"stage\"><video id=\"v\" autoplay playsinline muted></video></div>\n",
        "<div id=\"overlay\">",
        "<span id=\"status\">connecting...</span>",
        "<span id=\"hint\">Q=Select W=Start | arrows=move | Z=B X=A</span>",
        "</div>\n",
    );
    let html = format!(
        "{html}<script>\n\
const JOIN=\"{join}\",ROOM=\"{room}\",WORKER=\"{worker}\";\n\
const PEER_TOKEN=new URLSearchParams(location.search).get(\"peer_token\")||\"\";\n\
const WORKER_TOKEN=nuevo URLSearchParams(location.search).get(\"worker_token\")||\"\";\n\
const SERVER_ID=new URLSearchParams(location.search).get(\"server_id\")||\"\";\n\
const SEAT=parseInt(new URLSearchParams(location.search).get(\"seat\")||\"0\");\n\
const ROLE=new URLSearchParams(location.search).get(\"role\")||\"player\";\n\
const ICE=[{{urls:[\"stun:stun.l.google.com:19302\",\"stun:stun1.l.google.com:19302\"]}},{{urls:\"turn:lngnckr.tech:3478\",username:\"gv\",credential:\"43b908d07b1f25c97553d43d317ee5fb\"}}];\n\
\n\
function $$(id){{return document.getElementById(id)}}\n\
function setStatus(t,ok){{var s=$$(\"status\");s.textContent=t;if(ok===!0)s.className=\"ok\";else if(ok===!1)s.className=\"err\";else s.className=\"\"}}\n\
\n\
(async()=>{{\n\
  const v=$$(\"v\");\n\
  try{{\n\
    const pc=new RTCPeerConnection({{iceServers:ICE}});\n\
    pc.onconnectionstatechange=()=>{{\n\
      var cs=pc.connectionState;\n\
      if(cs===\"connected\")setStatus(\"connected\",!0);\n\
      else if(cs===\"disconnected\"||cs===\"failed\")setStatus(cs,!1);\n\
      else setStatus(cs)\n\
    }};\n\
    pc.ontrack=e=>{{if(!v.srcObject)v.srcObject=new MediaStream();v.srcObject.addTrack(e.track);v.play().catch(()=>{{}})}};\n\
    pc.addTransceiver(\"video\",{{direction:\"recvonly\"}});\n\
    pc.addTransceiver(\"audio\",{{direction:\"recvonly\"}});\n\
    setStatus(\"signaling...\");\n\
    const offer=await pc.createOffer();\n\
    await pc.setLocalDescription(offer);\n\
    await new Promise(r=>{{if(pc.iceGatheringState===\"complete\")r();else pc.addEventListener(\"icegatheringstatechange\",()=>{{if(pc.iceGatheringState===\"complete\")r()}})}});\n\
    setStatus(\"connecting...\");\n\
    const sdpResp=await fetch(\"/sdp\",{{method:\"POST\",headers:{{\"Content-Type\":\"application/json\"}},body:JSON.stringify({{sdp:pc.localDescription.sdp,peer_token:PEER_TOKEN,peer_role:ROLE,peer_seat:SEAT}})}});\n\
    if(!sdpResp.ok){{setStatus(\"SDP failed: \"+sdpResp.status,!1);console.error(\"sdp failed\",sdpResp.status);return}}\n\
    const answer=await sdpResp.json();\n\
    const clean=answer.sdp.split(\"\\n\").filter(l=>!l.trimStart().startsWith(\"a=extmap:\")).join(\"\\n\");\n\
    await pc.setRemoteDescription({{type:\"answer\",sdp:clean}});\n\
    console.log(\"[gv] WebRTC connected via direct SDP\");\n\
  }}catch(e){{setStatus(e.message,!1);console.error(e)}}\n\
}})();\n\
</script></body></html>"
    );

    (
        axum::http::StatusCode::OK,
        [(axum::http::header::CONTENT_TYPE, "text/html; charset=utf-8")],
        html,
    )
}
