//! Minimal HTTP server that proxies the gv-web player page + all API calls.
//! The browser loads the full Next.js GamePlayer UI from gv-web through this
//! server (same-origin proxy).  All API calls and static assets flow through
//! to gv-web — no inline HTML, no separate player bundle.

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
        .route("/_next/*path", any(proxy))
        .route("/player/*path", any(proxy))
        .route("/favicon.ico", any(proxy))
        .fallback(any(proxy_player_page))
        .with_state(state)
}

/// Proxy the gv-web player page.  Extracts the `code` query param from
/// the LAN URL and proxies to gv-web's `/p/<code>` page so the browser
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

    proxy_to_gv_web(&state, req, &path_and_query).await
}

async fn health(State(state): State<Arc<AppState>>) -> Json<PlayerHealth> {
    Json(health_payload(&state))
}

/// Proxy all /api/*, /sdp, /_next/*, /player/* requests to gv-web.
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
    proxy_to_gv_web(&state, req, &path).await
}

/// Shared proxy helper — forwards the request to gv-web and returns the response.
async fn proxy_to_gv_web(
    state: &AppState,
    req: Request,
    path: &str,
) -> Result<axum::response::Response, axum::http::StatusCode> {
    let target = format!("{}{}", state.gv_web, path);

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
