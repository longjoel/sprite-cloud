mod test_pattern;

use axum::{routing::get, routing::post, Json, Router};
use serde::{Deserialize, Serialize};
use std::net::SocketAddr;

#[derive(Debug, Deserialize)]
struct SdpOffer {
    sdp: String,
}

#[derive(Debug, Serialize)]
struct SdpAnswer {
    sdp: String,
}

async fn handle_offer(Json(offer): Json<SdpOffer>) -> Json<SdpAnswer> {
    Json(SdpAnswer {
        sdp: format!("answer: {}", &offer.sdp[..20.min(offer.sdp.len())]),
    })
}

async fn handle_test_frame() -> axum::body::Bytes {
    axum::body::Bytes::from(test_pattern::generate_color_bars(320, 240, 0))
}

#[tokio::main]
async fn main() {
    let port: u16 = std::env::args()
        .nth(1)
        .and_then(|p| p.parse().ok())
        .unwrap_or(0);

    let app = Router::new()
        .route("/sdp", post(handle_offer))
        .route("/test-frame", get(handle_test_frame));

    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let listener = tokio::net::TcpListener::bind(addr).await.unwrap();
    let actual_port = listener.local_addr().unwrap().port();

    println!("gv-worker listening on port {}", actual_port);
    axum::serve(listener, app).await.unwrap();
}
