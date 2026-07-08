//! Minimal HTTP server that serves the LAN player page + proxies API calls.
//! No cross-origin dependencies — GvPlayer JS is bundled inline, API calls
//! are proxied same-origin through this server to gv-web.

use axum::{
    Router,
    body::Body,
    extract::{Request, State},
    response::{Html, Json},
    routing::{any, get},
};
use reqwest::Client;
use serde::Serialize;
use std::net::SocketAddr;
use std::sync::Arc;

struct AppState {
    client: Client,
    gv_web: String,
    server_id: String,
    user_id: String,
    server_name: String,
    bind: SocketAddr,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
struct PlayerHealth {
    status: &'static str,
    service: &'static str,
    lan_player: bool,
    version: &'static str,
    server_id: String,
    user_id: String,
    server_name: String,
    bind: String,
}

fn health_payload(state: &AppState) -> PlayerHealth {
    PlayerHealth {
        status: "ok",
        service: "gv-server-player",
        lan_player: true,
        version: env!("CARGO_PKG_VERSION"),
        server_id: state.server_id.clone(),
        user_id: state.user_id.clone(),
        server_name: state.server_name.clone(),
        bind: state.bind.to_string(),
    }
}

fn app_router(state: Arc<AppState>) -> Router {
    Router::new()
        .route("/health", get(health))
        .route("/api/*path", any(proxy))
        .route("/sdp", any(proxy))
        .fallback(get(player_page))
        .with_state(state)
}

/// HTML page with bundled GvPlayer JS and inline connection logic.
/// Loaded over HTTP so browser exposes real LAN IP (no mDNS).
fn player_html() -> String {
    let bundle = include_str!("player_bundle.js");
    format!(
        r#"<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>GV LAN Player</title>
<style>
  *{{margin:0;padding:0;box-sizing:border-box}}
  body{{background:#000;color:#fff;font-family:system-ui,sans-serif}}
  video{{width:100%;height:100vh;object-fit:contain;display:block}}
  #status{{position:fixed;top:10px;left:10px;padding:6px 14px;background:rgba(0,0,0,.7);border-radius:6px;font-size:13px;z-index:10}}
  #status.ok{{color:#4f4}} #status.err{{color:#f44}}
  #route-indicator{{position:fixed;top:10px;right:10px;padding:4px 10px;background:rgba(0,0,0,.7);border-radius:4px;font-size:12px;color:#aaa;z-index:10}}
  .hidden{{display:none!important}}
  #connecting-overlay{{position:fixed;inset:0;background:rgba(0,0,0,.85);display:flex;align-items:center;justify-content:center;flex-direction:column;z-index:20}}
  .spinner{{width:40px;height:40px;border:3px solid #333;border-top-color:#4f4;border-radius:50%;animation:spin .8s linear infinite;margin-bottom:12px}}
  @keyframes spin{{to{{transform:rotate(360deg)}}}}
  #connecting-detail{{font-size:14px;color:#aaa}}
  #controls{{position:fixed;bottom:16px;left:50%;transform:translateX(-50%);display:flex;gap:8px;z-index:10}}
  #controls button{{padding:8px 20px;background:rgba(255,255,255,.1);color:#fff;border:1px solid rgba(255,255,255,.2);border-radius:6px;font-size:14px;cursor:pointer}}
  #controls button:hover{{background:rgba(255,255,255,.2)}}
</style>
</head>
<body>
<video id="video" autoplay playsinline muted></video>
<div id="status">loading…</div>
<div id="route-indicator"></div>
<div id="connecting-overlay">
  <div class="spinner"></div>
  <div id="connecting-detail"></div>
</div>
<div id="controls">
  <button id="save-btn" onclick="sendCmd('save_state')">💾 Save</button>
  <button id="load-btn" onclick="sendCmd('load_state')">📂 Load</button>
</div>
<script>{bundle}</script>
<script>
// ── Polyfills for insecure HTTP context ──
if (!crypto.randomUUID) {{
  crypto.randomUUID = function() {{
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {{
      var r = Math.random() * 16 | 0;
      return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    }});
  }};
}}
// ── LAN player — use bundled GvPlayer, all API calls same-origin ──
const {{ GvPlayer, State }} = Gv;

const q = new URLSearchParams(location.search);
const fragment = new URLSearchParams(location.hash.replace(/^#/, ''));
const joinToken = q.get('join') || '';
const peerToken = q.get('peer_token') || '';
const seat = parseInt(q.get('seat') || '0');
const role = q.get('role') || 'player';
const serverId = q.get('server_id') || '';
const gameId = decodeURIComponent(location.pathname.split('/')[1] || '');
let workerToken = q.get('worker_token') || '';
let sdpAnswer = null;

const ICE = [
  {{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }},
];

const el = (id) => document.getElementById(id);
function status(msg, cls) {{
  const s = el('status');
  if (s) {{ s.textContent = msg; s.className = cls || ''; }}
}}
function hideOverlay() {{ el('connecting-overlay')?.classList.add('hidden'); }}

const video = el('video');
if (!video) throw new Error('no video element');

const player = new GvPlayer(video, {{ seat, iceServers: ICE }});
window._player = player;
player._peerToken = peerToken;
player._seat = seat;
player._role = role;

player.onStateChange = (s, d) => {{
  if (s === State.CONNECTED) {{ status('connected', 'ok'); hideOverlay(); }}
  else if (s === State.ERROR) status(d || 'error', 'err');
  else status(s);
}};

player._onRoute = (route) => {{
  const r = el('route-indicator');
  if (r) r.textContent = route;
}};

status('joining…');

(async () => {{
  try {{
    // Stable guest client ID for room/join (sessionStorage or random).
    const clientId = (() => {{
      try {{
        let id = sessionStorage.getItem('gv_guest_client_id');
        if (!id) {{ id = crypto.randomUUID(); sessionStorage.setItem('gv_guest_client_id', id); }}
        return id;
      }} catch (_) {{ return crypto.randomUUID(); }}
    }})();

    // Guest join via room token (same-origin — proxied to gv-web)
    // Always join when joinToken is present — ignore stale peer_token from URL.
    if (joinToken) {{
      const jr = await fetch('/api/room/join', {{
        method: 'POST',
        headers: {{ 'Content-Type': 'application/json' }},
        body: JSON.stringify({{ room_token: joinToken, client_id: clientId }}),
      }});
      const jd = await jr.json();
      if (!jr.ok) throw new Error(jd.error || 'Join failed');
      player._peerToken = jd.peer_token;
      player._seat = jd.seat;
      player._role = jd.role;
    }}

    async function startLanHostGame() {{
      const hostToken = fragment.get('host_token') || q.get('host_token') || '';
      if (!hostToken) throw new Error('missing LAN host token');
      status('starting LAN game…');
      player._createPeerConnection();
      const offer = await player._pc.createOffer();
      await player._pc.setLocalDescription(offer);
      await player._waitForIceGatheringComplete();
      const sdp = player._pc.localDescription?.sdp || offer.sdp;
      const resp = await fetch('/api/server/command', {{
        method: 'POST',
        headers: {{ 'Content-Type': 'application/json' }},
        body: JSON.stringify({{
          server_id: serverId,
          type: 'start_game',
          payload: {{ game_id: gameId, host_token: hostToken, lan: true, sdp }},
        }}),
      }});
      const data = await resp.json().catch(() => ({{}}));
      if (!resp.ok) throw new Error(data.error || 'LAN start failed');
      workerToken = data.worker_token || workerToken;
      sdpAnswer = data.sdp_answer || null;
      return hostToken;
    }}

    const hostToken = joinToken ? null : await startLanHostGame();
    status('connecting…');
    await player.connectViaRelay(serverId, gameId, hostToken, workerToken, joinToken, player._peerToken, sdpAnswer);
  }} catch (e) {{
    status(e.message || 'Connection failed', 'err');
    console.error(e);
  }}
}})();

window.sendCmd = (cmd) => {{
  const dc = player._dc;
  if (!dc || dc.readyState !== 'open') return false;
  dc.send(JSON.stringify({{ cmd }}));
  return true;
}};
</script>
</body>
</html>"#
    )
}

async fn player_page() -> Html<String> {
    Html(player_html())
}

async fn health(State(state): State<Arc<AppState>>) -> Json<PlayerHealth> {
    Json(health_payload(&state))
}

/// Proxy all /api/* and /sdp requests to gv-web (same-origin → no CORS).
async fn proxy(
    State(state): State<Arc<AppState>>,
    req: Request,
) -> Result<axum::response::Response, axum::http::StatusCode> {
    let path = req
        .uri()
        .path_and_query()
        .map(|pq| pq.as_str())
        .unwrap_or("/");
    let target = format!("{}{}", state.gv_web, path);

    let method = req.method().clone();
    let headers: Vec<(String, String)> = req
        .headers()
        .iter()
        .filter_map(|(k, v)| {
            let name = k.as_str().to_lowercase();
            // Skip hop-by-hop headers
            if name == "host" || name == "connection" {
                return None;
            }
            Some((k.to_string(), v.to_str().ok()?.to_string()))
        })
        .collect();

    let body_bytes = axum::body::to_bytes(req.into_body(), 1024 * 1024)
        .await
        .unwrap_or_default();

    let mut builder = state.client.request(method, &target);
    for (k, v) in &headers {
        builder = builder.header(k.as_str(), v);
    }

    let resp = builder
        .body(body_bytes.to_vec())
        .send()
        .await
        .map_err(|e| {
            tracing::warn!("[player] proxy error: {e}");
            axum::http::StatusCode::BAD_GATEWAY
        })?;

    let status = resp.status();
    let resp_headers = resp.headers().clone();
    let resp_body = resp.bytes().await.unwrap_or_default();

    let mut response = axum::response::Response::new(Body::from(resp_body));
    *response.status_mut() = status;
    for (k, v) in resp_headers.iter() {
        if k.as_str().to_lowercase() != "transfer-encoding" {
            response.headers_mut().insert(k.clone(), v.clone());
        }
    }

    Ok(response)
}

pub async fn serve(
    bind: SocketAddr,
    gv_web: String,
    server_id: String,
    user_id: String,
    server_name: String,
) {
    let state = Arc::new(AppState {
        client: Client::new(),
        gv_web,
        server_id,
        user_id,
        server_name,
        bind,
    });

    let app = app_router(state);

    tracing::info!("[player] HTTP server listening on http://{bind}");

    let listener = match tokio::net::TcpListener::bind(bind).await {
        Ok(l) => l,
        Err(e) => {
            tracing::error!("[player] failed to bind {bind}: {e:#}");
            return;
        }
    };

    if let Err(e) = axum::serve(listener, app).await {
        tracing::error!("[player] HTTP server error: {e:#}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::{Request, StatusCode};
    use tower::ServiceExt;

    #[test]
    fn health_payload_is_non_secret_lan_probe_identity() {
        let state = AppState {
            client: Client::new(),
            gv_web: "https://lngnckr.tech".to_string(),
            server_id: "server-bazzite".to_string(),
            user_id: "user-joel".to_string(),
            server_name: "Bazzite".to_string(),
            bind: "0.0.0.0:8787".parse().unwrap(),
        };

        let payload = health_payload(&state);

        assert_eq!(payload.status, "ok");
        assert_eq!(payload.service, "gv-server-player");
        assert!(payload.lan_player);
        assert_eq!(payload.version, env!("CARGO_PKG_VERSION"));
        assert_eq!(payload.server_id, "server-bazzite");
        assert_eq!(payload.user_id, "user-joel");
        assert_eq!(payload.server_name, "Bazzite");
        assert_eq!(payload.bind, "0.0.0.0:8787");
    }

    #[tokio::test]
    async fn health_route_returns_json_without_proxying() {
        let state = Arc::new(AppState {
            client: Client::new(),
            gv_web: "https://lngnckr.tech".to_string(),
            server_id: "server-vault".to_string(),
            user_id: "user-joel".to_string(),
            server_name: "Vault".to_string(),
            bind: "0.0.0.0:8787".parse().unwrap(),
        });
        let app = app_router(state);

        let response = app
            .oneshot(
                Request::builder()
                    .uri("/health")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let content_type = response
            .headers()
            .get(axum::http::header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .unwrap_or_default();
        assert!(content_type.starts_with("application/json"));
    }
}
