pub mod config;
pub mod encoder_probe;
pub mod gst_video;
pub mod gst_audio;
pub mod core_bridge;
pub mod saves;
pub mod player_assets;
pub mod main_body;

use std::net::SocketAddr;
use tokio::net::TcpListener;

pub const VERSION: &str = env!("CARGO_PKG_VERSION");
pub const LIBRETRO_RUNNER_VERSION: &str = libretro_runner::VERSION;

pub async fn run_worker(port: u16) -> Result<(), Box<dyn std::error::Error>> {
    // try_init so single-binary dispatch (gv-server worker) doesn't panic
    // when the parent already initialized the global subscriber.
    tracing_subscriber::fmt()
        .json()
        .with_target(false)
        .with_current_span(false)
        .try_init()
        .ok();

    gstreamer::init().map_err(|e| format!("gst init: {e}"))?;

    let app = main_body::build_app().await?;
    let addr = SocketAddr::from(([0, 0, 0, 0], port));
    let listener = std::net::TcpListener::bind(addr)?;
    listener.set_nonblocking(true)?;
    let bound_port = listener.local_addr()?.port();
    let tcp_listener = TcpListener::from_std(listener)?;

    tracing::info!("gv-worker listening on port {bound_port}");
    eprintln!("WORKER_READY port={bound_port}");
    tracing::info!("open http://localhost:{bound_port}");

    // ── Run the HTTP server on a DEDICATED tokio runtime on its own OS thread ──
    // GStreamer appsrc (16 threads) + WebRTC ICE saturation can starve
    // the main runtime of worker threads, leaving axum unable to process
    // incoming HTTP requests.  By running HTTP on a separate OS thread
    // with its own tokio runtime, the SDP endpoint always has capacity.
    //
    // We cannot call block_on from within #[tokio::main] (tokio panics:
    // "Cannot start a runtime from within a runtime").  Spawn a fresh
    // OS thread instead.
    let server_thread = std::thread::Builder::new()
        .name("http-server".into())
        .spawn(move || {
            let http_rt = tokio::runtime::Builder::new_multi_thread()
                .worker_threads(2)
                .enable_all()
                .build()
                .expect("http runtime");

            http_rt.block_on(async move {
                axum::serve(tcp_listener, app)
                    .with_graceful_shutdown(async move {
                        tokio::signal::ctrl_c().await.ok();
                    })
                    .await
                    .map_err(|e| eprintln!("http server error: {e}"))
                    .ok();
            })
        })?;

    server_thread.join().unwrap();
    Ok(())
}
