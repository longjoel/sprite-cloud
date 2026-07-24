//! Minimal HTTP server that proxies the sc-web player page + all API calls.
//! The browser loads the full Next.js GamePlayer UI from sc-web through this
//! server (same-origin proxy).  All API calls and static assets flow through
//! to sc-web — no inline HTML, no separate player bundle.

use axum::{
    Router,
    body::Body,
    extract::{Path, Query, Request, State},
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
    preferences: Arc<tokio::sync::Mutex<crate::library_state::LibraryStateStore>>,
}

/// Game library and scan state for standalone mode.
#[derive(Clone)]
pub(crate) struct LocalGame {
    id: String,
    content_path: std::path::PathBuf,
    discovered: crate::scan::DiscoveredFile,
}

impl LocalGame {
    pub(crate) fn new(root: &str, discovered: crate::scan::DiscoveredFile) -> Self {
        use sha2::{Digest, Sha256};

        let root_path = std::path::Path::new(root);
        let content_path = root_path.join(&discovered.relative_path);
        let mut hasher = Sha256::new();
        hasher.update(root_path.as_os_str().as_encoded_bytes());
        hasher.update([0]);
        hasher.update(discovered.relative_path.as_bytes());
        let digest = hasher.finalize();
        let id = format!("local_{}", hex::encode(&digest[..16]));

        Self {
            id,
            content_path,
            discovered,
        }
    }
}

#[derive(Clone)]
struct StandaloneState {
    game_list: Arc<tokio::sync::RwLock<Vec<LocalGame>>>,
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
        .route("/api/favorites", get(list_favorites).post(toggle_favorite))
        .route("/api/pins", get(list_pins).post(toggle_pin))
        .route("/api/recent-plays", get(list_recent_plays))
        .route("/api/games/:id", get(proxy).put(rename_game))
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

pub(crate) type SharedLibraryState =
    Arc<tokio::sync::Mutex<crate::library_state::LibraryStateStore>>;

pub(crate) fn open_library_preferences() -> std::io::Result<SharedLibraryState> {
    crate::library_state::LibraryStateStore::load(crate::library_state::state_path())
        .map(|store| Arc::new(tokio::sync::Mutex::new(store)))
}

pub(crate) async fn serve(
    bind: SocketAddr,
    sc_web: String,
    server_id: String,
    user_id: String,
    server_name: String,
    lan_player_enabled: bool,
    game_list: Arc<tokio::sync::RwLock<Vec<LocalGame>>>,
    rom_roots: Arc<Vec<String>>,
    preferences: SharedLibraryState,
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
        preferences,
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
pub(crate) async fn serve_standalone(
    bind: SocketAddr,
    game_list: Arc<tokio::sync::RwLock<Vec<LocalGame>>>,
    rom_roots: Arc<Vec<String>>,
    preferences: SharedLibraryState,
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
        preferences,
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
    favorite: bool,
    pinned: bool,
    #[serde(rename = "playedAt", skip_serializing_if = "Option::is_none")]
    played_at: Option<String>,
}

#[derive(Default, Deserialize)]
struct GameListQuery {
    limit: Option<usize>,
    offset: Option<usize>,
    search: Option<String>,
    #[serde(default)]
    pins_first: bool,
    #[serde(default)]
    ids_only: bool,
}

async fn list_games(
    Query(query): Query<GameListQuery>,
    State(state): State<Arc<AppState>>,
) -> Result<Json<serde_json::Value>, axum::http::StatusCode> {
    let standalone = state
        .standalone
        .as_ref()
        .ok_or(axum::http::StatusCode::NOT_FOUND)?;
    let preferences = state.preferences.lock().await.snapshot();
    let games = standalone.game_list.read().await;
    let search = query.search.unwrap_or_default().trim().to_lowercase();
    let mut entries: Vec<GameEntry> = games
        .iter()
        .filter(|game| {
            let fallback = local_game_name(game);
            search.is_empty()
                || preferences
                    .display_name(&game.id, &fallback)
                    .to_lowercase()
                    .contains(&search)
        })
        .map(|game| game_entry(game, &state, &preferences))
        .collect();
    entries.sort_by(|left, right| {
        query
            .pins_first
            .then(|| right.pinned.cmp(&left.pinned))
            .filter(|ordering| !ordering.is_eq())
            .unwrap_or_else(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
    });

    let total = entries.len();
    let offset = query.offset.unwrap_or(0).min(total);
    let limit = query.limit.unwrap_or(100).clamp(1, 200);
    let page: Vec<GameEntry> = entries.into_iter().skip(offset).take(limit).collect();

    Ok(Json(serde_json::json!({ "games": page, "total": total })))
}

fn local_game_name(game: &LocalGame) -> String {
    std::path::Path::new(&game.discovered.file_name)
        .file_stem()
        .and_then(|stem| stem.to_str())
        .unwrap_or(&game.discovered.file_name)
        .to_string()
}

fn game_entry(
    game: &LocalGame,
    state: &AppState,
    preferences: &crate::library_state::LibraryPreferences,
) -> GameEntry {
    let fallback = local_game_name(game);
    GameEntry {
        id: game.id.clone(),
        name: preferences.display_name(&game.id, &fallback).to_string(),
        platform: game
            .discovered
            .platform
            .clone()
            .unwrap_or_else(|| "unknown".to_string()),
        server_id: state.server_id.clone(),
        max_players: 1,
        favorite: preferences.is_favorite(&game.id),
        pinned: preferences.is_pinned(&game.id),
        played_at: preferences.recent.get(&game.id).cloned(),
    }
}

async fn local_game_exists(state: &AppState, game_id: &str) -> bool {
    let Some(standalone) = state.standalone.as_ref() else {
        return false;
    };
    standalone
        .game_list
        .read()
        .await
        .iter()
        .any(|game| game.id == game_id)
}

async fn preference_entries(
    state: &AppState,
    predicate: impl Fn(&GameEntry) -> bool,
) -> Vec<GameEntry> {
    let Some(standalone) = state.standalone.as_ref() else {
        return Vec::new();
    };
    let preferences = state.preferences.lock().await.snapshot();
    let games = standalone.game_list.read().await;
    games
        .iter()
        .map(|game| game_entry(game, state, &preferences))
        .filter(predicate)
        .collect()
}

async fn list_favorites(
    Query(query): Query<GameListQuery>,
    State(state): State<Arc<AppState>>,
) -> Result<Json<serde_json::Value>, axum::http::StatusCode> {
    let search = query.search.unwrap_or_default().trim().to_lowercase();
    let mut entries = preference_entries(&state, |game| {
        game.favorite && (search.is_empty() || game.name.to_lowercase().contains(&search))
    })
    .await;
    entries.sort_by(|left, right| left.name.to_lowercase().cmp(&right.name.to_lowercase()));
    let total = entries.len();
    let offset = query.offset.unwrap_or(0).min(total);
    let limit = query.limit.unwrap_or(100).clamp(1, 200);
    let page: Vec<_> = entries.into_iter().skip(offset).take(limit).collect();
    Ok(Json(serde_json::json!({ "games": page, "total": total })))
}

#[derive(Deserialize)]
struct GamePreferenceRequest {
    #[serde(rename = "gameId")]
    game_id: String,
}

async fn toggle_favorite(
    State(state): State<Arc<AppState>>,
    Json(request): Json<GamePreferenceRequest>,
) -> Result<Json<serde_json::Value>, axum::http::StatusCode> {
    if !local_game_exists(&state, &request.game_id).await {
        return Err(axum::http::StatusCode::NOT_FOUND);
    }
    let favorited = state
        .preferences
        .lock()
        .await
        .toggle_favorite(&request.game_id)
        .map_err(|_| axum::http::StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(serde_json::json!({ "favorited": favorited })))
}

async fn list_pins(
    Query(query): Query<GameListQuery>,
    State(state): State<Arc<AppState>>,
) -> Result<Json<serde_json::Value>, axum::http::StatusCode> {
    let preferences = state.preferences.lock().await.snapshot();
    if query.ids_only {
        return Ok(Json(serde_json::json!({ "ids": preferences.pins })));
    }
    let entries = preference_entries(&state, |game| game.pinned).await;
    let by_id: std::collections::HashMap<_, _> = entries
        .into_iter()
        .map(|entry| (entry.id.clone(), entry))
        .collect();
    let ordered: Vec<_> = preferences
        .pins
        .iter()
        .filter_map(|id| by_id.get(id))
        .collect();
    Ok(Json(serde_json::json!({ "games": ordered })))
}

async fn toggle_pin(
    State(state): State<Arc<AppState>>,
    Json(request): Json<GamePreferenceRequest>,
) -> Result<Json<serde_json::Value>, axum::http::StatusCode> {
    if !local_game_exists(&state, &request.game_id).await {
        return Err(axum::http::StatusCode::NOT_FOUND);
    }
    let mut preferences = state.preferences.lock().await;
    let pinned = preferences
        .toggle_pin(&request.game_id)
        .map_err(|_| axum::http::StatusCode::INTERNAL_SERVER_ERROR)?
        .map_err(|_| axum::http::StatusCode::BAD_REQUEST)?;
    let pin_count = preferences.snapshot().pins.len();
    Ok(Json(
        serde_json::json!({ "pinned": pinned, "pinCount": pin_count }),
    ))
}

async fn list_recent_plays(
    Query(query): Query<GameListQuery>,
    State(state): State<Arc<AppState>>,
) -> Result<Json<serde_json::Value>, axum::http::StatusCode> {
    let search = query.search.unwrap_or_default().trim().to_lowercase();
    let mut entries = preference_entries(&state, |game| {
        game.played_at.is_some()
            && (search.is_empty() || game.name.to_lowercase().contains(&search))
    })
    .await;
    entries.sort_by(|left, right| right.played_at.cmp(&left.played_at));
    let total = entries.len();
    let offset = query.offset.unwrap_or(0).min(total);
    let limit = query.limit.unwrap_or(100).clamp(1, 200);
    let page: Vec<_> = entries.into_iter().skip(offset).take(limit).collect();
    Ok(Json(serde_json::json!({ "games": page, "total": total })))
}

fn current_timestamp() -> Result<String, axum::http::StatusCode> {
    time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .map_err(|_| axum::http::StatusCode::INTERNAL_SERVER_ERROR)
}

#[derive(Deserialize)]
struct RenameGameRequest {
    name: String,
}

async fn rename_game(
    Path(game_id): Path<String>,
    State(state): State<Arc<AppState>>,
    Json(request): Json<RenameGameRequest>,
) -> Result<Json<serde_json::Value>, axum::http::StatusCode> {
    if !local_game_exists(&state, &game_id).await {
        return Err(axum::http::StatusCode::NOT_FOUND);
    }
    let name = request.name.trim();
    if name.is_empty() || name.len() > 200 {
        return Err(axum::http::StatusCode::BAD_REQUEST);
    }
    state
        .preferences
        .lock()
        .await
        .rename(&game_id, name)
        .map_err(|_| axum::http::StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(
        serde_json::json!({ "game": { "id": game_id, "name": name } }),
    ))
}

pub(crate) fn resolve_local_game(
    game_id: &str,
    games: &[LocalGame],
    rom_roots: &[String],
) -> Result<(std::path::PathBuf, String), String> {
    let game = games
        .iter()
        .find(|candidate| candidate.id == game_id)
        .ok_or_else(|| "game not found".to_string())?;
    let resolved = crate::scan::resolve_within_roots(&game.content_path, rom_roots)
        .map_err(|error| error.to_string())?;

    Ok((
        resolved,
        game.discovered
            .platform
            .clone()
            .unwrap_or_else(|| "unknown".to_string()),
    ))
}

fn new_runtime_session_id() -> String {
    format!("{:032x}", rand::random::<u128>())
}

#[derive(Deserialize)]
struct LocalLaunchRequest {
    game_id: String,
    sdp: String,
}

async fn shutdown_local_session(session: &Arc<crate::session::GameSession>) {
    session.cancel.cancel();
    let pc = session.pc.lock().ok().map(|pc| pc.clone());
    if let Some(pc) = pc {
        let _ = pc.close().await;
    }
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

    let session_id = new_runtime_session_id();
    let session = Arc::new(crate::session::GameSession {
        game_id: session_id.clone(),
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

    if let Err(message) = crate::core_bridge::load_core_into_session(
        &session,
        Some(&core_path),
        content_path.to_str(),
        Some(&platform),
    )
    .await
    {
        shutdown_local_session(&session).await;
        return Err(api_error(
            axum::http::StatusCode::BAD_GATEWAY,
            &format!("core startup failed: {message}"),
        ));
    }
    crate::commands::dc_handler::wire_dc_handler(&session);

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
            shutdown_local_session(&session).await;
            return Err(api_error(axum::http::StatusCode::BAD_GATEWAY, &message));
        }
    };

    let streaming_session = Arc::clone(&session);
    tokio::spawn(async move {
        crate::streaming::run_stream(streaming_session).await;
    });

    state
        .sessions
        .lock()
        .await
        .insert(session_id.clone(), Arc::clone(&session));

    let cleanup_sessions = Arc::clone(&state.sessions);
    let cleanup_session = Arc::clone(&session);
    let cleanup_id = session_id.clone();
    tokio::spawn(async move {
        cleanup_session.cancel.cancelled().await;
        shutdown_local_session(&cleanup_session).await;
        let mut sessions = cleanup_sessions.lock().await;
        if sessions
            .get(&cleanup_id)
            .is_some_and(|current| Arc::ptr_eq(current, &cleanup_session))
        {
            sessions.remove(&cleanup_id);
        }
    });
    if let Ok(played_at) = current_timestamp()
        && let Err(error) = state
            .preferences
            .lock()
            .await
            .record_played(&request.game_id, &played_at)
    {
        tracing::warn!("[library] failed to record recent play: {error}");
    }
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
        let mut all: Vec<LocalGame> = Vec::new();
        for root in roots.iter() {
            let path = std::path::Path::new(root);
            if !path.is_dir() {
                continue;
            }
            if let Ok(files) = crate::scan::discover_roms(path) {
                all.extend(files.into_iter().map(|file| LocalGame::new(root, file)));
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
    let preferences = state.preferences.lock().await.snapshot();
    let hostname = state.server_name.clone();
    let count = games.len();

    // Group by platform while retaining the opaque local game id for launch.
    let mut platforms: std::collections::BTreeMap<String, Vec<(String, String, bool, bool)>> =
        std::collections::BTreeMap::new();
    for game in games.iter() {
        let platform = game
            .discovered
            .platform
            .clone()
            .unwrap_or_else(|| "other".to_string());
        platforms.entry(platform).or_default().push((
            game.id.clone(),
            preferences
                .display_name(&game.id, &local_game_name(game))
                .to_string(),
            preferences.is_favorite(&game.id),
            preferences.is_pinned(&game.id),
        ));
    }

    let mut platform_sections = String::new();
    for (platform, entries) in &platforms {
        platform_sections.push_str(&format!(
            "<details open><summary><strong>{}</strong> <span class=\"count\">({})</span></summary><ul>",
            html_escape(platform), entries.len()
        ));
        for (game_id, name, favorite, pinned) in entries {
            platform_sections.push_str(&format!(
                "<li><span>{}</span><button class=\"pref\" data-game-id=\"{}\" onclick=\"togglePreference('/api/favorites',this.dataset.gameId)\">{}</button><button class=\"pref\" data-game-id=\"{}\" onclick=\"togglePreference('/api/pins',this.dataset.gameId)\">{}</button><button class=\"pref\" data-game-id=\"{}\" data-name=\"{}\" onclick=\"renameGame(this.dataset.gameId,this.dataset.name)\">Rename</button><button class=\"play\" data-game-id=\"{}\" onclick=\"launchGame(this.dataset.gameId)\">Play</button></li>",
                html_escape(name),
                html_escape(game_id),
                if *favorite { "★" } else { "☆" },
                html_escape(game_id),
                if *pinned { "Pinned" } else { "Pin" },
                html_escape(game_id),
                html_escape(name),
                html_escape(game_id)
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
  .pref {{ padding: 4px 8px; border-color: #202d49; }}
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
  let launchGeneration = 0;
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

  function setPlayButtonsDisabled(disabled) {{
    document.querySelectorAll('.play').forEach(button => button.disabled = disabled);
  }}

  async function launchGame(gameId) {{
    closePlayer();
    const generation = launchGeneration;
    const overlay = document.getElementById('player');
    const playerStatus = document.getElementById('playerStatus');
    setPlayButtonsDisabled(true);
    overlay.classList.add('active');
    playerStatus.textContent = 'Starting ' + gameId + '…';
    const connection = new RTCPeerConnection();
    pc = connection;
    connection.addTransceiver('video', {{direction:'recvonly'}});
    connection.addTransceiver('audio', {{direction:'recvonly'}});
    const channel = connection.createDataChannel('diagnostics');
    dc = channel;
    channel.binaryType = 'arraybuffer';
    channel.onopen = () => {{ channel.send(JSON.stringify({{cmd:'auth', local_players:1}})); playerStatus.textContent = 'Connected'; }};
    connection.ontrack = event => {{
      const element = event.track.kind === 'video' ? document.getElementById('video') : document.getElementById('audio');
      element.srcObject = event.streams[0];
      element.play().catch(() => {{ playerStatus.textContent = 'Tap to start playback'; }});
    }};
    connection.onconnectionstatechange = () => {{ playerStatus.textContent = connection.connectionState; }};
    try {{
      const offer = await connection.createOffer();
      await connection.setLocalDescription(offer);
      await waitForIce(connection);
      const response = await fetch('/api/launch', {{
        method: 'POST',
        headers: {{'Content-Type':'application/json'}},
        body: JSON.stringify({{game_id:gameId, sdp:connection.localDescription.sdp}})
      }});
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Launch failed');
      if (generation !== launchGeneration) {{ stopSession(result.session_id); return; }}
      activeSessionId = result.session_id;
      if (!overlay.classList.contains('active')) {{ stopActiveGame(); return; }}
      await connection.setRemoteDescription({{type:'answer', sdp:result.sdp}});
    }} catch (error) {{
      if (generation === launchGeneration) {{
        stopActiveGame();
        playerStatus.textContent = error.message;
      }}
    }} finally {{
      if (generation === launchGeneration) setPlayButtonsDisabled(false);
    }}
  }}

  function stopSession(sessionId) {{
    if (!sessionId) return;
    const body = JSON.stringify({{session_id:sessionId}});
    if (navigator.sendBeacon) {{
      navigator.sendBeacon('/api/stop', new Blob([body], {{type:'application/json'}}));
    }} else {{
      fetch('/api/stop', {{method:'POST', headers:{{'Content-Type':'application/json'}}, body, keepalive:true}})
        .catch(error => console.warn('Failed to stop game:', error));
    }}
  }}

  function stopActiveGame() {{
    const sessionId = activeSessionId;
    activeSessionId = null;
    stopSession(sessionId);
  }}

  function closePlayer() {{
    launchGeneration++;
    setPlayButtonsDisabled(false);
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

  async function togglePreference(path, gameId) {{
    const response = await fetch(path, {{
      method: 'POST', headers: {{'Content-Type':'application/json'}},
      body: JSON.stringify({{gameId}})
    }});
    if (!response.ok) throw new Error('Preference update failed');
    location.reload();
  }}

  async function renameGame(gameId, currentName) {{
    const name = prompt('Game name', currentName);
    if (!name || name.trim() === currentName) return;
    const response = await fetch('/api/games/' + encodeURIComponent(gameId), {{
      method: 'PUT', headers: {{'Content-Type':'application/json'}},
      body: JSON.stringify({{name:name.trim()}})
    }});
    if (!response.ok) throw new Error('Rename failed');
    location.reload();
  }}

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

    fn test_preferences() -> Arc<tokio::sync::Mutex<crate::library_state::LibraryStateStore>> {
        let path = std::env::temp_dir().join(format!(
            "sc-library-state-test-{:032x}.json",
            rand::random::<u128>()
        ));
        Arc::new(tokio::sync::Mutex::new(
            crate::library_state::LibraryStateStore::load(path).unwrap(),
        ))
    }

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
            preferences: test_preferences(),
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
            preferences: test_preferences(),
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
    fn runtime_session_ids_are_unique_and_filesystem_safe() {
        let first = new_runtime_session_id();
        let second = new_runtime_session_id();

        assert_ne!(first, second);
        assert_eq!(first.len(), 32);
        assert!(first.bytes().all(|byte| byte.is_ascii_hexdigit()));
    }

    #[tokio::test]
    async fn standalone_player_offer_requests_audio_video_and_data() {
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
            preferences: test_preferences(),
        });

        let html = library_page(State(state)).await.unwrap().0;
        assert!(html.contains("addTransceiver('video', {direction:'recvonly'})"));
        assert!(html.contains("addTransceiver('audio', {direction:'recvonly'})"));
        assert!(html.contains("createDataChannel('diagnostics')"));
        assert!(html.contains("launchGeneration"));
        assert!(html.contains("const connection = new RTCPeerConnection()"));
        assert!(html.contains("connection.localDescription.sdp"));
        assert!(html.contains("stopSession(result.session_id)"));
        assert!(html.contains("function closePlayer()"));
        assert!(html.contains("function setPlayButtonsDisabled(disabled)"));
        assert!(html.contains("launchGeneration++;\n    setPlayButtonsDisabled(false);"));
    }

    #[tokio::test]
    async fn standalone_library_preferences_are_durable_and_reflected_in_games() {
        let local_game = LocalGame::new(
            "/roms",
            crate::scan::DiscoveredFile {
                relative_path: "snes/super-mario-world.sfc".to_string(),
                file_name: "super-mario-world.sfc".to_string(),
                file_size: 524_288,
                sha256: None,
                crc: None,
                platform: Some("snes".to_string()),
            },
        );
        let game_id = local_game.id.clone();
        let preferences = test_preferences();
        preferences
            .lock()
            .await
            .record_played(&game_id, "2026-07-23T22:00:00Z")
            .unwrap();
        let state = Arc::new(AppState {
            client: Client::new(),
            sc_web: String::new(),
            server_id: "standalone".to_string(),
            user_id: "local".to_string(),
            server_name: "Local".to_string(),
            bind: "127.0.0.1:8787".parse().unwrap(),
            lan_player_enabled: true,
            standalone: Some(StandaloneState {
                game_list: Arc::new(tokio::sync::RwLock::new(vec![local_game])),
                rom_roots: Arc::new(vec!["/roms".to_string()]),
            }),
            sessions: Arc::new(tokio::sync::Mutex::new(std::collections::HashMap::new())),
            preferences,
        });
        let app = app_router().with_state(state);

        for (path, body) in [
            ("/api/favorites", serde_json::json!({ "gameId": game_id })),
            ("/api/pins", serde_json::json!({ "gameId": game_id })),
        ] {
            let response = app
                .clone()
                .oneshot(
                    Request::builder()
                        .method("POST")
                        .uri(path)
                        .header("content-type", "application/json")
                        .body(Body::from(body.to_string()))
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::OK);
        }

        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("PUT")
                    .uri(format!("/api/games/{game_id}"))
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"name":"Super Mario World"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);

        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/games?pins_first=true")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let body: serde_json::Value = serde_json::from_slice(&body).unwrap();
        let game = &body["games"][0];
        assert_eq!(game["name"], "Super Mario World");
        assert_eq!(game["favorite"], true);
        assert_eq!(game["pinned"], true);
        assert!(game["playedAt"].as_str().unwrap().ends_with('Z'));

        let response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/recent-plays")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        serde_json::json!({ "gameId": game_id }).to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::METHOD_NOT_ALLOWED);
    }

    #[test]
    fn local_game_ids_are_stable_opaque_and_root_scoped() {
        let discovered = crate::scan::DiscoveredFile {
            relative_path: "snes/Super Mario World.sfc".to_string(),
            file_name: "Super Mario World.sfc".to_string(),
            file_size: 512,
            sha256: None,
            crc: None,
            platform: Some("snes".to_string()),
        };
        let first = LocalGame::new("/roms-a", discovered.clone());
        let same = LocalGame::new("/roms-a", discovered.clone());
        let other_root = LocalGame::new("/roms-b", discovered);

        assert_eq!(first.id, same.id);
        assert_ne!(first.id, other_root.id);
        assert!(first.id.starts_with("local_"));
        assert!(!first.id.to_lowercase().contains("mario"));
        assert!(!first.id.contains('/'));
    }

    #[test]
    fn local_launch_rejects_paths_outside_configured_rom_roots() {
        let game = LocalGame::new(
            "/roms",
            crate::scan::DiscoveredFile {
                relative_path: "../private/secret.sfc".to_string(),
                file_name: "secret.sfc".to_string(),
                file_size: 1,
                sha256: None,
                crc: None,
                platform: Some("snes".to_string()),
            },
        );
        let game_id = game.id.clone();
        let roots = vec!["/roms".to_string()];

        assert!(resolve_local_game(&game_id, &[game], &roots).is_err());
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
            preferences: test_preferences(),
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
            preferences: test_preferences(),
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
    async fn paired_preferences_use_the_same_trusted_lan_boundary_as_library_reads() {
        let state = Arc::new(AppState {
            client: Client::new(),
            sc_web: "https://sprite-cloud.com".to_string(),
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
            preferences: test_preferences(),
        });
        let response = app_router()
            .with_state(state)
            .oneshot(
                Request::builder()
                    .uri("/api/favorites")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn paired_game_detail_get_still_proxies_to_sc_web() {
        let state = Arc::new(AppState {
            client: Client::new(),
            sc_web: "http://127.0.0.1:1".to_string(),
            server_id: "server-vault".to_string(),
            user_id: "user-joel".to_string(),
            server_name: "Vault".to_string(),
            bind: "0.0.0.0:8787".parse().unwrap(),
            lan_player_enabled: true,
            standalone: None,
            sessions: Arc::new(tokio::sync::Mutex::new(std::collections::HashMap::new())),
            preferences: test_preferences(),
        });
        let response = app_router()
            .with_state(state)
            .oneshot(
                Request::builder()
                    .uri("/api/games/legacy-game-id")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::BAD_GATEWAY);
    }

    #[tokio::test]
    async fn paired_mode_serves_game_library_locally_instead_of_proxying() {
        let local_game = LocalGame::new(
            "/roms",
            crate::scan::DiscoveredFile {
                relative_path: "snes/super-mario-world.sfc".to_string(),
                file_name: "super-mario-world.sfc".to_string(),
                file_size: 524_288,
                sha256: None,
                crc: None,
                platform: Some("snes".to_string()),
            },
        );
        let expected_id = local_game.id.clone();
        let game_list = Arc::new(tokio::sync::RwLock::new(vec![local_game]));
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
            preferences: test_preferences(),
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
        assert_eq!(payload["games"][0]["id"], expected_id);
        assert_eq!(payload["games"][0]["platform"], "snes");
        assert_eq!(payload["games"][0]["serverId"], "server-vault");
        assert_eq!(payload["games"][0]["maxPlayers"], 1);
    }
}
