//! Minimal HTTP server that proxies the sc-web player page + all API calls.
//! The browser loads the full Next.js GamePlayer UI from sc-web through this
//! server (same-origin proxy).  All API calls and static assets flow through
//! to sc-web — no inline HTML, no separate player bundle.

use axum::{
    Router,
    body::Body,
    extract::{Query, Request, State},
    response::Json,
    routing::{any, get},
};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::net::SocketAddr;
use std::sync::Arc;

struct AppState {
    client: Client,
    sc_web: String,
    server_id: String,
    user_id: String,
    server_name: String,
    bind: SocketAddr,
    lan_player_enabled: bool,
    /// Present when the local library API is enabled (paired and standalone).
    standalone: Option<StandaloneState>,
    sessions: Arc<
        tokio::sync::Mutex<std::collections::HashMap<String, Arc<crate::session::GameSession>>>,
    >,
}

/// Game library and scan state for standalone mode.
#[derive(Clone)]
struct StandaloneState {
    game_list: Arc<tokio::sync::RwLock<Vec<crate::scan::DiscoveredFile>>>,
    rom_roots: Arc<Vec<String>>,
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
        service: "sc-server-player",
        lan_player: state.lan_player_enabled,
        version: env!("CARGO_PKG_VERSION"),
        server_id: state.server_id.clone(),
        user_id: state.user_id.clone(),
        server_name: state.server_name.clone(),
        bind: state.bind.to_string(),
    }
}

fn app_router() -> Router<Arc<AppState>> {
    Router::new()
        // These exact routes are always owned by sc-server. The wildcard proxy
        // below handles only cloud/auth/signaling routes that remain in sc-web.
        .route("/api/games", get(list_games))
        .route("/health", get(health))
        .route("/api/*path", any(proxy))
        .route("/sdp", any(proxy))
        .route("/_next/*path", any(proxy))
        .route("/player/*path", any(proxy))
        .route("/favicon.ico", any(proxy))
        .fallback(any(proxy_player_page))
}

/// Proxy the sc-web player page.  Extracts the `code` query param from
/// the LAN URL and proxies to sc-web's `/p/<code>` page so the browser
/// gets the full Next.js GamePlayer UI.
async fn proxy_player_page(
    State(state): State<Arc<AppState>>,
    req: Request,
) -> Result<axum::response::Response, axum::http::StatusCode> {
    let qs: Vec<(String, String)> = req
        .uri()
        .query()
        .map(|q| {
            url::form_urlencoded::parse(q.as_bytes())
                .map(|(k, v)| (k.into_owned(), v.into_owned()))
                .collect()
        })
        .unwrap_or_default();

    let code = qs
        .iter()
        .find(|(k, _)| k == "code")
        .map(|(_, v)| v.as_str())
        .unwrap_or("");

    let path_and_query = if code.is_empty() {
        req.uri()
            .path_and_query()
            .map(|pq| pq.as_str())
            .unwrap_or("/")
            .to_string()
    } else {
        let query_str = qs
            .iter()
            .map(|(k, v)| {
                format!(
                    "{}={}",
                    url::form_urlencoded::byte_serialize(k.as_bytes()).collect::<String>(),
                    url::form_urlencoded::byte_serialize(v.as_bytes()).collect::<String>(),
                )
            })
            .collect::<Vec<_>>()
            .join("&");
        format!("/p/{}?{}", code, query_str)
    };

    proxy_to_sc_web(&state, req, &path_and_query).await
}

async fn health(State(state): State<Arc<AppState>>) -> Json<PlayerHealth> {
    Json(health_payload(&state))
}

/// Proxy all /api/*, /sdp, /_next/*, /player/* requests to sc-web.
async fn proxy(
    State(state): State<Arc<AppState>>,
    req: Request,
) -> Result<axum::response::Response, axum::http::StatusCode> {
    let path = req
        .uri()
        .path_and_query()
        .map(|pq| pq.as_str())
        .unwrap_or("/")
        .to_string();
    proxy_to_sc_web(&state, req, &path).await
}

/// Shared proxy helper — forwards the request to sc-web and returns the response.
async fn proxy_to_sc_web(
    state: &AppState,
    req: Request,
    path: &str,
) -> Result<axum::response::Response, axum::http::StatusCode> {
    let target = format!("{}{}", state.sc_web, path);

    let method = req.method().clone();
    let headers: Vec<(String, String)> = req
        .headers()
        .iter()
        .filter_map(|(k, v)| {
            let name = k.as_str().to_lowercase();
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
            tracing::warn!("[player] proxy error ({path}): {e}");
            axum::http::StatusCode::BAD_GATEWAY
        })?;

    let status = resp.status();
    let resp_headers = resp.headers().clone();
    let resp_body = resp.bytes().await.unwrap_or_default();

    let mut response = axum::response::Response::new(Body::from(resp_body));
    *response.status_mut() = status;
    for (k, v) in resp_headers.iter() {
        let key = k.as_str().to_lowercase();
        if key == "transfer-encoding" {
            continue;
        }
        // Strip Secure flag and __Secure- prefix from Set-Cookie — the LAN proxy serves over HTTP
        if key == "set-cookie" {
            if let Ok(val) = v.to_str() {
                let sanitized = val
                    .split(';')
                    .map(|p| p.trim())
                    .filter(|p| !p.eq_ignore_ascii_case("secure"))
                    .collect::<Vec<_>>()
                    .join("; ");
                // Strip __Secure- and __Host- prefixes (browsers reject over HTTP)
                let sanitized = sanitized
                    .replacen("__Secure-", "", 1)
                    .replacen("__Host-", "", 1);
                response
                    .headers_mut()
                    .insert(k.clone(), sanitized.parse().unwrap_or_else(|_| v.clone()));
                continue;
            }
        }
        response.headers_mut().insert(k.clone(), v.clone());
    }

    // Clear __Secure- auth cookies that browsers reject over HTTP
    response.headers_mut().insert(
        axum::http::header::SET_COOKIE,
        "authjs.callback-url=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax"
            .parse()
            .unwrap(),
    );

    Ok(response)
}

pub async fn serve(
    bind: SocketAddr,
    sc_web: String,
    server_id: String,
    user_id: String,
    server_name: String,
    lan_player_enabled: bool,
    game_list: Arc<tokio::sync::RwLock<Vec<crate::scan::DiscoveredFile>>>,
    rom_roots: Arc<Vec<String>>,
) {
    let state = Arc::new(AppState {
        client: Client::new(),
        sc_web,
        server_id,
        user_id,
        server_name,
        bind,
        lan_player_enabled,
        standalone: Some(StandaloneState {
            game_list,
            rom_roots,
        }),
        sessions: Arc::new(tokio::sync::Mutex::new(std::collections::HashMap::new())),
    });

    let app = app_router().with_state(state);

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

/// Standalone mode — no sc-web, local game library API.
pub async fn serve_standalone(
    bind: SocketAddr,
    game_list: Arc<tokio::sync::RwLock<Vec<crate::scan::DiscoveredFile>>>,
    rom_roots: Arc<Vec<String>>,
) {
    let standalone = StandaloneState {
        game_list,
        rom_roots,
    };

    let state = Arc::new(AppState {
        client: Client::new(),
        sc_web: String::new(),
        server_id: "standalone".to_string(),
        user_id: "local".to_string(),
        server_name: hostname(),
        bind,
        lan_player_enabled: true,
        standalone: Some(standalone),
        sessions: Arc::new(tokio::sync::Mutex::new(std::collections::HashMap::new())),
    });

    let app = app_router()
        .route("/api/scan", axum::routing::post(trigger_scan))
        .route("/api/launch", axum::routing::post(launch_game))
        .route("/api/stop", axum::routing::post(stop_game))
        .route("/", get(library_page))
        .with_state(state);

    tracing::info!("[player] Standalone server listening on http://{bind}");

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

fn hostname() -> String {
    std::fs::read_to_string("/proc/sys/kernel/hostname")
        .map(|s| s.trim().to_string())
        .unwrap_or_else(|_| "unknown".to_string())
}

// ── Standalone API handlers ─────────────────────────────────────────

#[derive(Serialize)]
struct GameEntry {
    id: String,
    name: String,
    platform: String,
    #[serde(rename = "serverId")]
    server_id: String,
    #[serde(rename = "maxPlayers")]
    max_players: u8,
}

#[derive(Default, Deserialize)]
struct GameListQuery {
    limit: Option<usize>,
    offset: Option<usize>,
    search: Option<String>,
}

async fn list_games(
    Query(query): Query<GameListQuery>,
    State(state): State<Arc<AppState>>,
) -> Result<Json<serde_json::Value>, axum::http::StatusCode> {
    let standalone = state
        .standalone
        .as_ref()
        .ok_or(axum::http::StatusCode::NOT_FOUND)?;
    let games = standalone.game_list.read().await;
    let search = query.search.unwrap_or_default().trim().to_lowercase();
    let mut entries: Vec<GameEntry> = games
        .iter()
        .filter(|file| search.is_empty() || file.file_name.to_lowercase().contains(&search))
        .map(|file| GameEntry {
            id: file.relative_path.clone(),
            name: std::path::Path::new(&file.file_name)
                .file_stem()
                .and_then(|stem| stem.to_str())
                .unwrap_or(&file.file_name)
                .to_string(),
            platform: file
                .platform
                .clone()
                .unwrap_or_else(|| "unknown".to_string()),
            server_id: state.server_id.clone(),
            max_players: 1,
        })
        .collect();
    entries.sort_by(|left, right| left.name.to_lowercase().cmp(&right.name.to_lowercase()));

    let total = entries.len();
    let offset = query.offset.unwrap_or(0).min(total);
    let limit = query.limit.unwrap_or(100).clamp(1, 200);
    let page: Vec<GameEntry> = entries.into_iter().skip(offset).take(limit).collect();

    Ok(Json(serde_json::json!({ "games": page, "total": total })))
}

fn resolve_local_game(
    game_id: &str,
    games: &[crate::scan::DiscoveredFile],
    rom_roots: &[String],
) -> Result<(std::path::PathBuf, String), String> {
    let relative = std::path::Path::new(game_id);
    if relative.is_absolute()
        || relative.components().any(|component| {
            matches!(
                component,
                std::path::Component::ParentDir
                    | std::path::Component::RootDir
                    | std::path::Component::Prefix(_)
            )
        })
    {
        return Err("invalid game id".to_string());
    }

    let game = games
        .iter()
        .find(|candidate| candidate.relative_path == game_id)
        .ok_or_else(|| "game not found".to_string())?;

    for root in rom_roots {
        let candidate = std::path::Path::new(root).join(relative);
        if !candidate.exists() {
            continue;
        }
        let resolved = crate::scan::resolve_within_roots(&candidate, rom_roots)
            .map_err(|error| error.to_string())?;
        return Ok((
            resolved,
            game.platform
                .clone()
                .unwrap_or_else(|| "unknown".to_string()),
        ));
    }

    Err("ROM file not found".to_string())
}

#[derive(Deserialize)]
struct LocalLaunchRequest {
    game_id: String,
    sdp: String,
}

async fn launch_game(
    State(state): State<Arc<AppState>>,
    Json(request): Json<LocalLaunchRequest>,
) -> Result<Json<serde_json::Value>, (axum::http::StatusCode, Json<serde_json::Value>)> {
    let library = state.standalone.as_ref().ok_or_else(|| {
        api_error(
            axum::http::StatusCode::SERVICE_UNAVAILABLE,
            "local library unavailable",
        )
    })?;

    let (content_path, platform) = {
        let games = library.game_list.read().await;
        resolve_local_game(&request.game_id, &games, &library.rom_roots)
            .map_err(|message| api_error(axum::http::StatusCode::BAD_REQUEST, &message))?
    };

    if request.sdp.trim().is_empty() {
        return Err(api_error(
            axum::http::StatusCode::BAD_REQUEST,
            "SDP offer required",
        ));
    }

    let core_filename = crate::platform::core_for_platform(&platform)
        .ok_or_else(|| api_error(axum::http::StatusCode::BAD_REQUEST, "unsupported platform"))?;
    let core_path = crate::core_bridge::ensure_core(&core_filename, &state.client)
        .await
        .map_err(|message| api_error(axum::http::StatusCode::BAD_GATEWAY, &message))?;
    let stack = crate::webrtc::build_session_pc_lan()
        .await
        .map_err(|message| api_error(axum::http::StatusCode::INTERNAL_SERVER_ERROR, &message))?;
    let rom_hash = crate::saves::hash_rom(&content_path);

    let session = Arc::new(crate::session::GameSession {
        game_id: request.game_id.clone(),
        cancel: tokio_util::sync::CancellationToken::new(),
        pc: std::sync::Mutex::new(stack.pc),
        video_track: std::sync::Mutex::new(stack.video_track),
        audio_track: std::sync::Mutex::new(stack.audio_track),
        dc: tokio::sync::Mutex::new(None),
        guests: tokio::sync::Mutex::new(Vec::new()),
        host_connected: std::sync::atomic::AtomicBool::new(false),
        local_players: std::sync::atomic::AtomicU32::new(1),
        core_loaded: std::sync::atomic::AtomicBool::new(false),
        core_loading: std::sync::atomic::AtomicBool::new(false),
        core_cmd_tx: tokio::sync::Mutex::new(None),
        core_frame_rx: tokio::sync::Mutex::new(None),
        core_response_rx: tokio::sync::Mutex::new(None),
        video_enc: tokio::sync::Mutex::new(None),
        audio_enc: tokio::sync::Mutex::new(None),
        rom_hash: tokio::sync::Mutex::new(rom_hash),
        core_width: tokio::sync::Mutex::new(0),
        core_height: tokio::sync::Mutex::new(0),
        core_fps: tokio::sync::Mutex::new(0.0),
        core_sample_rate: tokio::sync::Mutex::new(48_000.0),
    });

    crate::core_bridge::load_core_into_session(
        &session,
        Some(&core_path),
        content_path.to_str(),
        Some(&platform),
    )
    .await;
    crate::commands::dc_handler::wire_dc_handler(&session);

    let streaming_session = Arc::clone(&session);
    tokio::spawn(async move {
        crate::streaming::run_stream(streaming_session).await;
    });

    let pc = session
        .pc
        .lock()
        .map_err(|_| {
            api_error(
                axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                "peer connection state unavailable",
            )
        })?
        .clone();
    let answer = match crate::webrtc::exchange_sdp_on_pc(&pc, &request.sdp).await {
        Ok(answer) => answer,
        Err(message) => {
            session.cancel.cancel();
            return Err(api_error(axum::http::StatusCode::BAD_GATEWAY, &message));
        }
    };

    let session_id = format!("{:032x}", rand::random::<u128>());
    state
        .sessions
        .lock()
        .await
        .insert(session_id.clone(), session);
    Ok(Json(serde_json::json!({
        "status": "ready",
        "game_id": request.game_id,
        "session_id": session_id,
        "sdp": answer,
    })))
}

#[derive(Deserialize)]
struct LocalStopRequest {
    session_id: String,
}

async fn stop_game(
    State(state): State<Arc<AppState>>,
    Json(request): Json<LocalStopRequest>,
) -> Json<serde_json::Value> {
    let stopped = if let Some(session) = state.sessions.lock().await.remove(&request.session_id) {
        session.cancel.cancel();
        true
    } else {
        false
    };
    Json(serde_json::json!({ "status": "ok", "stopped": stopped }))
}

fn api_error(
    status: axum::http::StatusCode,
    message: &str,
) -> (axum::http::StatusCode, Json<serde_json::Value>) {
    (status, Json(serde_json::json!({ "error": message })))
}

async fn trigger_scan(
    State(state): State<Arc<AppState>>,
) -> Result<Json<serde_json::Value>, axum::http::StatusCode> {
    let standalone = state
        .standalone
        .as_ref()
        .ok_or(axum::http::StatusCode::NOT_FOUND)?;
    let roots = standalone.rom_roots.clone();

    // Run scan in a blocking task
    let result = tokio::task::spawn_blocking(move || {
        let mut all: Vec<crate::scan::DiscoveredFile> = Vec::new();
        for root in roots.iter() {
            let path = std::path::Path::new(root);
            if !path.is_dir() {
                continue;
            }
            if let Ok(files) = crate::scan::discover_roms(path) {
                all.extend(files);
            }
        }
        all
    })
    .await
    .map_err(|_| axum::http::StatusCode::INTERNAL_SERVER_ERROR)?;

    let count = result.len();
    {
        let mut games = standalone.game_list.write().await;
        *games = result;
    }

    Ok(Json(serde_json::json!({ "status": "ok", "count": count })))
}

// ── Standalone library page ──────────────────────────────────────────

async fn library_page(
    State(state): State<Arc<AppState>>,
) -> Result<axum::response::Html<String>, axum::http::StatusCode> {
    let standalone = state
        .standalone
        .as_ref()
        .ok_or(axum::http::StatusCode::NOT_FOUND)?;
    let games = standalone.game_list.read().await;
    let hostname = state.server_name.clone();
    let count = games.len();

    // Group by platform while retaining the opaque local game id for launch.
    let mut platforms: std::collections::BTreeMap<String, Vec<(String, String)>> =
        std::collections::BTreeMap::new();
    for game in games.iter() {
        let platform = game.platform.clone().unwrap_or_else(|| "other".to_string());
        platforms
            .entry(platform)
            .or_default()
            .push((game.relative_path.clone(), game.file_name.clone()));
    }

    let mut platform_sections = String::new();
    for (platform, entries) in &platforms {
        platform_sections.push_str(&format!(
            "<details open><summary><strong>{}</strong> <span class=\"count\">({})</span></summary><ul>",
            html_escape(platform), entries.len()
        ));
        for (game_id, name) in entries {
            platform_sections.push_str(&format!(
                "<li><span>{}</span><button class=\"play\" data-game-id=\"{}\" onclick=\"launchGame(this.dataset.gameId)\">Play</button></li>",
                html_escape(name), html_escape(game_id)
            ));
        }
        platform_sections.push_str("</ul></details>");
    }

    let html = format!(
        r#"<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sprite Cloud — {hostname}</title>
<style>
  * {{ box-sizing: border-box; margin: 0; padding: 0; }}
  body {{ font-family: 'SFMono-Regular', Consolas, monospace; background: #0a0e1a; color: #e0e8f0; max-width: 1000px; margin: 0 auto; padding: 24px 16px; }}
  h1 {{ font-size: 1.5rem; margin-bottom: 8px; color: #38bdf8; }}
  .subtitle {{ color: #8aa0b8; font-size: 0.85rem; margin-bottom: 24px; }}
  .toolbar {{ display: flex; gap: 12px; margin-bottom: 20px; align-items: center; }}
  button {{ background: #121a2f; color: #e0e8f0; border: 1px solid #38bdf8; padding: 8px 16px; border-radius: 2px; cursor: pointer; font: inherit; font-size: 0.85rem; }}
  button:hover {{ background: #172441; }}
  button:disabled {{ opacity: .5; cursor: wait; }}
  .play {{ margin-left: auto; padding: 4px 12px; }}
  .count {{ color: #8aa0b8; font-size: 0.8rem; }}
  details {{ margin-bottom: 12px; background: #10172a; border: 1px solid #202d49; border-radius: 2px; padding: 12px 16px; }}
  summary {{ cursor: pointer; font-size: 1rem; padding: 4px 0; }}
  ul {{ list-style: none; margin-top: 8px; }}
  li {{ display: flex; align-items: center; gap: 12px; padding: 6px 0; border-bottom: 1px solid #202d49; font-size: 0.9rem; }}
  li:last-child {{ border-bottom: none; }}
  #status {{ color: #38bdf8; font-size: 0.85rem; }}
  #player {{ display: none; position: fixed; inset: 0; z-index: 10; background: #000; }}
  #player.active {{ display: flex; align-items: center; justify-content: center; }}
  #player video {{ width: 100%; height: 100%; object-fit: contain; }}
  #closePlayer {{ position: absolute; top: 12px; right: 12px; z-index: 11; }}
  #playerStatus {{ position: absolute; left: 12px; top: 12px; z-index: 11; color: #38bdf8; background: #0a0e1acc; padding: 6px 10px; }}
</style>
</head>
<body>
<h1>🎮 {hostname}</h1>
<p class="subtitle">Standalone mode — {count} games across {platform_count} platforms</p>
<div class="toolbar">
  <button onclick="rescan()">🔄 Rescan</button>
  <span id="status"></span>
</div>
<div id="content">
  {platform_sections}
</div>
<div id="player">
  <div id="playerStatus">Connecting…</div>
  <button id="closePlayer" onclick="closePlayer()">Close</button>
  <video id="video" autoplay playsinline></video>
  <audio id="audio" autoplay></audio>
</div>
<script>
  let pc = null;
  let dc = null;
  let activeSessionId = null;
  let inputState = 0;
  const keyBits = {{ ArrowUp:4, ArrowDown:5, ArrowLeft:6, ArrowRight:7,
    w:4, s:5, a:6, d:7, z:0, x:8, c:9, v:1, f:10, g:11,
    r:12, t:13, q:3, e:2, Enter:3, ' ':3, Shift:2 }};

  function waitForIce(connection) {{
    if (connection.iceGatheringState === 'complete') return Promise.resolve();
    return new Promise(resolve => {{
      const timeout = setTimeout(resolve, 3000);
      connection.addEventListener('icegatheringstatechange', () => {{
        if (connection.iceGatheringState === 'complete') {{ clearTimeout(timeout); resolve(); }}
      }});
    }});
  }}

  function sendInput() {{
    if (dc && dc.readyState === 'open') dc.send(new Uint8Array([0, inputState & 255, inputState >> 8]));
  }}

  async function launchGame(gameId) {{
    closePlayer();
    const overlay = document.getElementById('player');
    const playerStatus = document.getElementById('playerStatus');
    overlay.classList.add('active');
    playerStatus.textContent = 'Starting ' + gameId + '…';
    pc = new RTCPeerConnection();
    dc = pc.createDataChannel('diagnostics');
    dc.binaryType = 'arraybuffer';
    dc.onopen = () => {{ dc.send(JSON.stringify({{cmd:'auth', local_players:1}})); playerStatus.textContent = 'Connected'; }};
    pc.ontrack = event => {{
      const element = event.track.kind === 'video' ? document.getElementById('video') : document.getElementById('audio');
      element.srcObject = event.streams[0];
      element.play().catch(() => {{ playerStatus.textContent = 'Tap to start playback'; }});
    }};
    pc.onconnectionstatechange = () => {{ playerStatus.textContent = pc.connectionState; }};
    try {{
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await waitForIce(pc);
      const response = await fetch('/api/launch', {{
        method: 'POST',
        headers: {{'Content-Type':'application/json'}},
        body: JSON.stringify({{game_id:gameId, sdp:pc.localDescription.sdp}})
      }});
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Launch failed');
      activeSessionId = result.session_id;
      if (!overlay.classList.contains('active')) {{ stopActiveGame(); return; }}
      await pc.setRemoteDescription({{type:'answer', sdp:result.sdp}});
    }} catch (error) {{
      stopActiveGame();
      playerStatus.textContent = error.message;
    }}
  }}

  function stopActiveGame() {{
    if (!activeSessionId) return;
    const sessionId = activeSessionId;
    activeSessionId = null;
    const body = JSON.stringify({{session_id:sessionId}});
    if (navigator.sendBeacon) {{
      navigator.sendBeacon('/api/stop', new Blob([body], {{type:'application/json'}}));
    }} else {{
      fetch('/api/stop', {{method:'POST', headers:{{'Content-Type':'application/json'}}, body, keepalive:true}})
        .catch(error => console.warn('Failed to stop game:', error));
    }}
  }}

  function closePlayer() {{
    inputState = 0; sendInput();
    if (dc) dc.close();
    if (pc) pc.close();
    dc = null; pc = null;
    stopActiveGame();
    document.getElementById('player').classList.remove('active');
  }}

  for (const type of ['keydown','keyup']) document.addEventListener(type, event => {{
    const bit = keyBits[event.key];
    if (bit === undefined || !document.getElementById('player').classList.contains('active')) return;
    event.preventDefault();
    if (type === 'keydown') inputState |= (1 << bit); else inputState &= ~(1 << bit);
    sendInput();
  }});
  window.addEventListener('blur', () => {{ inputState = 0; sendInput(); }});
  window.addEventListener('pagehide', stopActiveGame);

  async function rescan() {{
    const btn = document.querySelector('button');
    const status = document.getElementById('status');
    btn.disabled = true;
    status.textContent = 'Scanning...';
    try {{
      const resp = await fetch('/api/scan', {{ method: 'POST' }});
      const data = await resp.json();
      status.textContent = `Found ${{data.count}} games.`;
      location.reload();
    }} catch(e) {{
      status.textContent = 'Scan failed: ' + e.message;
      btn.disabled = false;
    }}
  }}
</script>
</body>
</html>"#,
        hostname = hostname,
        count = count,
        platform_count = platforms.len(),
        platform_sections = platform_sections,
    );

    Ok(axum::response::Html(html))
}

fn html_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
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
            sc_web: "https://sprite-cloud.com".to_string(),
            server_id: "server-bazzite".to_string(),
            user_id: "user-joel".to_string(),
            server_name: "Bazzite".to_string(),
            bind: "0.0.0.0:8787".parse().unwrap(),
            lan_player_enabled: true,
            standalone: None,
            sessions: Arc::new(tokio::sync::Mutex::new(std::collections::HashMap::new())),
        };

        let payload = health_payload(&state);

        assert_eq!(payload.status, "ok");
        assert_eq!(payload.service, "sc-server-player");
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
            sc_web: "https://sprite-cloud.com".to_string(),
            server_id: "server-vault".to_string(),
            user_id: "user-joel".to_string(),
            server_name: "Vault".to_string(),
            bind: "0.0.0.0:8787".parse().unwrap(),
            lan_player_enabled: true,
            standalone: None,
            sessions: Arc::new(tokio::sync::Mutex::new(std::collections::HashMap::new())),
        });
        let app = app_router().with_state(state);

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

    #[test]
    fn local_launch_rejects_paths_outside_configured_rom_roots() {
        let games = vec![crate::scan::DiscoveredFile {
            relative_path: "../private/secret.sfc".to_string(),
            file_name: "secret.sfc".to_string(),
            file_size: 1,
            sha256: None,
            crc: None,
            platform: Some("snes".to_string()),
        }];
        let roots = vec!["/roms".to_string()];

        assert!(resolve_local_game("../private/secret.sfc", &games, &roots).is_err());
    }

    #[tokio::test]
    async fn standalone_stop_is_idempotent_for_missing_session() {
        let state = Arc::new(AppState {
            client: Client::new(),
            sc_web: String::new(),
            server_id: "standalone".to_string(),
            user_id: "local".to_string(),
            server_name: "Vault".to_string(),
            bind: "127.0.0.1:8787".parse().unwrap(),
            lan_player_enabled: true,
            standalone: Some(StandaloneState {
                game_list: Arc::new(tokio::sync::RwLock::new(Vec::new())),
                rom_roots: Arc::new(Vec::new()),
            }),
            sessions: Arc::new(tokio::sync::Mutex::new(std::collections::HashMap::new())),
        });
        let app = app_router()
            .route("/api/stop", axum::routing::post(stop_game))
            .with_state(state);

        let response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/stop")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"session_id":"missing"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let payload: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(payload["stopped"], false);
    }

    #[tokio::test]
    async fn paired_mode_does_not_expose_unauthenticated_local_launch() {
        let state = Arc::new(AppState {
            client: Client::new(),
            sc_web: "http://127.0.0.1:1".to_string(),
            server_id: "server-vault".to_string(),
            user_id: "user-joel".to_string(),
            server_name: "Vault".to_string(),
            bind: "0.0.0.0:8787".parse().unwrap(),
            lan_player_enabled: true,
            standalone: Some(StandaloneState {
                game_list: Arc::new(tokio::sync::RwLock::new(Vec::new())),
                rom_roots: Arc::new(vec!["/roms".to_string()]),
            }),
            sessions: Arc::new(tokio::sync::Mutex::new(std::collections::HashMap::new())),
        });
        let app = app_router().with_state(state);

        let response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/launch")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"game_id":"game.sfc","sdp":"offer"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::BAD_GATEWAY);
    }

    #[tokio::test]
    async fn paired_mode_serves_game_library_locally_instead_of_proxying() {
        let game_list = Arc::new(tokio::sync::RwLock::new(vec![
            crate::scan::DiscoveredFile {
                relative_path: "snes/super-mario-world.sfc".to_string(),
                file_name: "super-mario-world.sfc".to_string(),
                file_size: 524_288,
                sha256: None,
                crc: None,
                platform: Some("snes".to_string()),
            },
        ]));
        let state = Arc::new(AppState {
            client: Client::new(),
            sc_web: "http://127.0.0.1:1".to_string(),
            server_id: "server-vault".to_string(),
            user_id: "user-joel".to_string(),
            server_name: "Vault".to_string(),
            bind: "0.0.0.0:8787".parse().unwrap(),
            lan_player_enabled: true,
            standalone: Some(StandaloneState {
                game_list,
                rom_roots: Arc::new(vec!["/roms".to_string()]),
            }),
            sessions: Arc::new(tokio::sync::Mutex::new(std::collections::HashMap::new())),
        });
        let app = app_router().with_state(state);

        let response = app
            .oneshot(
                Request::builder()
                    .uri("/api/games")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let payload: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(payload["total"], 1);
        assert_eq!(payload["games"][0]["id"], "snes/super-mario-world.sfc");
        assert_eq!(payload["games"][0]["platform"], "snes");
        assert_eq!(payload["games"][0]["serverId"], "server-vault");
        assert_eq!(payload["games"][0]["maxPlayers"], 1);
    }
}
