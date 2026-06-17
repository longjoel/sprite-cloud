pub mod audio_pipeline;
pub mod config;
pub mod core_bridge;
pub mod saves;
pub mod test_pattern;
pub mod vp8_encoder;

// All types, handlers, and streaming logic — shared via include! between
// the binary (main.rs) and library (this file).
include!("main_body.rs");

/// Run the gv-worker HTTP server.
pub async fn run_worker(port: u16) -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt()
        .json()
        .with_target(false)
        .with_timer(tracing_subscriber::fmt::time::UtcTime::rfc_3339())
        .init();

    let _root = tracing::info_span!("", service = "gv-worker").entered();

    let host_token = std::env::var("GV_HOST_TOKEN").ok();
    let control_token = std::env::var("GV_WORKER_CONTROL_TOKEN").ok();

    if host_token.is_some() {
        tracing::info!("[STARTUP] host token set from GV_HOST_TOKEN env var");
    }
    if control_token.is_some() {
        tracing::info!("[STARTUP] worker control token required for HTTP control endpoints");
    } else {
        tracing::warn!("[STARTUP] GV_WORKER_CONTROL_TOKEN not set — worker HTTP control endpoints are unauthenticated");
    }

    let state = std::sync::Arc::new(AppState {
        cancel: tokio::sync::Mutex::new(tokio_util::sync::CancellationToken::new()),
        stream_handle: tokio::sync::Mutex::new(None),
        peer_connection: tokio::sync::Mutex::new(None),
        host_token: tokio::sync::Mutex::new(host_token),
        control_token,
        exit_signal: tokio_util::sync::CancellationToken::new(),
        destruct_timer: tokio::sync::Mutex::new(None),
        core_dims: tokio::sync::Mutex::new(None),
        core_loaded: std::sync::atomic::AtomicBool::new(false),
        frames_encoded: std::sync::atomic::AtomicU64::new(0),
    });

    use axum::routing::{get, post};
    let app = axum::Router::new()
        .route("/", get(handle_index))
        .route("/sdp", post(handle_offer))
        .route("/state", get(handle_connection_state))
        .route("/test-frame", get(handle_test_frame))
        .route("/health", get(handle_health))
        .route("/healthz", get(handle_healthz))
        .route("/shutdown", post(handle_shutdown))
        .layer(tower_http::cors::CorsLayer::permissive())
        .with_state(std::sync::Arc::clone(&state));

    let bind_host: std::net::IpAddr = std::env::var("GV_BIND_ADDR")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(std::net::IpAddr::from([127, 0, 0, 1]));

    let addr = std::net::SocketAddr::from((bind_host, port));
    let listener = tokio::net::TcpListener::bind(addr).await?;
    let actual_port = listener.local_addr()?.port();

    tracing::info!("gv-worker listening on port {}", actual_port);
    eprintln!("WORKER_READY port={}", actual_port);
    tracing::info!("open http://localhost:{}", actual_port);

    let exit = state.exit_signal.clone();
    {
        let exit_clone = exit.clone();
        let handle = tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_secs(
                config::WORKER_STARTUP_TIMEOUT_SECS,
            ))
            .await;
            tracing::warn!(
                "[SELF-DESTRUCT] no peer connected within {}s — shutting down",
                config::WORKER_STARTUP_TIMEOUT_SECS
            );
            exit_clone.cancel();
        });
        state.destruct_timer.lock().await.replace(handle);
    }

    let graceful = async move {
        exit.cancelled().await;
    };
    axum::serve(listener, app)
        .with_graceful_shutdown(graceful)
        .await?;
    Ok(())
}
