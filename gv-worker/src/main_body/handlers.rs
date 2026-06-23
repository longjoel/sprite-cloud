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
    _params: axum::extract::Query<std::collections::HashMap<String, String>>,
) -> impl axum::response::IntoResponse {
    // Serve the embedded player page. The inline connect.js reads
    // peer_token, role, seat etc. from location.search directly — no
    // server-side injection needed.
    crate::player_assets::serve_player_file("index.html")
}
