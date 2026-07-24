//! Minimal HTTP server that proxies the sc-web player page + all API calls.
//! The browser loads the full Next.js GamePlayer UI from sc-web through this
//! server (same-origin proxy).  All API calls and static assets flow through
//! to sc-web — no inline HTML, no separate player bundle.

use axum::{
    Router,
    body::Body,
    extract::{Request, State},
    response::Json,
    routing::{any, get},
};
use reqwest::Client;
use serde::Serialize;
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
    /// Present only in standalone mode — local game library and ROM roots.
    standalone: Option<StandaloneState>,
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
                    url::form_urlencoded::byte_serialize(k.as_bytes())
                        .collect::<String>(),
                    url::form_urlencoded::byte_serialize(v.as_bytes())
                        .collect::<String>(),
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
                response.headers_mut().insert(
                    k.clone(),
                    sanitized.parse().unwrap_or_else(|_| v.clone()),
                );
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
) {
    let state = Arc::new(AppState {
        client: Client::new(),
        sc_web,
        server_id,
        user_id,
        server_name,
        bind,
        lan_player_enabled,
        standalone: None,
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
    });

    let app = app_router()
        .route("/api/games", get(list_games))
        .route("/api/scan", axum::routing::post(trigger_scan))
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
    file_name: String,
    file_size: u64,
}

async fn list_games(
    State(state): State<Arc<AppState>>,
) -> Result<Json<Vec<GameEntry>>, axum::http::StatusCode> {
    let standalone = state.standalone.as_ref().ok_or(axum::http::StatusCode::NOT_FOUND)?;
    let games = standalone.game_list.read().await;
    let entries: Vec<GameEntry> = games
        .iter()
        .map(|f| {
            let name = f.file_name.trim_end_matches(&format!(".{}", f.platform.as_deref().unwrap_or("")))
                .to_string();
            GameEntry {
                id: f.relative_path.clone(),
                name,
                platform: f.platform.clone().unwrap_or_else(|| "unknown".to_string()),
                file_name: f.file_name.clone(),
                file_size: f.file_size,
            }
        })
        .collect();
    Ok(Json(entries))
}

async fn trigger_scan(
    State(state): State<Arc<AppState>>,
) -> Result<Json<serde_json::Value>, axum::http::StatusCode> {
    let standalone = state.standalone.as_ref().ok_or(axum::http::StatusCode::NOT_FOUND)?;
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
    let standalone = state.standalone.as_ref().ok_or(axum::http::StatusCode::NOT_FOUND)?;
    let games = standalone.game_list.read().await;
    let hostname = state.server_name.clone();
    let count = games.len();

    // Group by platform
    let mut platforms: std::collections::BTreeMap<String, Vec<String>> = std::collections::BTreeMap::new();
    for g in games.iter() {
        let plat = g.platform.clone().unwrap_or_else(|| "other".to_string());
        let name = g.file_name.clone();
        platforms.entry(plat).or_default().push(name);
    }

    let mut platform_sections = String::new();
    for (plat, names) in &platforms {
        platform_sections.push_str(&format!(
            "<details open><summary><strong>{}</strong> <span class=\"count\">({})</span></summary><ul>",
            plat, names.len()
        ));
        for name in names {
            platform_sections.push_str(&format!("<li>{}</li>", html_escape(name)));
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
  body {{ font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0f0f14; color: #e0e0e0; max-width: 900px; margin: 0 auto; padding: 24px 16px; }}
  h1 {{ font-size: 1.5rem; margin-bottom: 8px; }}
  .subtitle {{ color: #888; font-size: 0.85rem; margin-bottom: 24px; }}
  .toolbar {{ display: flex; gap: 12px; margin-bottom: 20px; align-items: center; }}
  button {{ background: #2a2a3e; color: #e0e0e0; border: 1px solid #444; padding: 8px 16px; border-radius: 6px; cursor: pointer; font-size: 0.9rem; }}
  button:hover {{ background: #3a3a4e; }}
  .count {{ color: #888; font-size: 0.8rem; }}
  details {{ margin-bottom: 12px; background: #1a1a24; border-radius: 8px; padding: 12px 16px; }}
  summary {{ cursor: pointer; font-size: 1rem; padding: 4px 0; }}
  ul {{ list-style: none; margin-top: 8px; }}
  li {{ padding: 6px 0; border-bottom: 1px solid #2a2a3e; font-size: 0.9rem; font-family: 'SF Mono', 'Fira Code', monospace; }}
  li:last-child {{ border-bottom: none; }}
  .empty {{ color: #666; text-align: center; padding: 60px 0; font-size: 1.1rem; }}
  #status {{ color: #4caf50; font-size: 0.85rem; }}
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
<script>
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
}
