// ── Embedded player assets ─────────────────────────────────────────────
//
// Player HTML + JS files compiled into the worker binary via rust-embed.
// When a user opens the worker's URL in a browser, the embedded player
// auto-connects to the worker's WebRTC endpoint.

use axum::{
    body::Body,
    http::{header, StatusCode},
    response::Response,
};
use rust_embed::RustEmbed;

#[derive(RustEmbed)]
#[folder = "assets/"]
struct PlayerAssets;

/// Serve a single embedded file by path (e.g. "index.html", "index.js").
/// Falls back to index.html for the root path.
pub fn serve_player_file(path: &str) -> Response<Body> {
    let file_path = if path.is_empty() || path == "/" {
        "index.html"
    } else {
        path.trim_start_matches('/')
    };

    let Some(file) = PlayerAssets::get(file_path) else {
        return Response::builder()
            .status(StatusCode::NOT_FOUND)
            .body(Body::from("not found"))
            .unwrap();
    };

    let mime = match file_path.rsplit('.').next() {
        Some("js") => "text/javascript".to_string(),
        Some("html") => "text/html; charset=utf-8".to_string(),
        Some("css") => "text/css".to_string(),
        _ => mime_guess::from_path(file_path)
            .first_or_octet_stream()
            .to_string(),
    };

    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, mime)
        .body(Body::from(file.data))
        .unwrap()
}
