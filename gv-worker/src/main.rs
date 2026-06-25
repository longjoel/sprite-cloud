// N100 has 4 cores — GStreamer + WebRTC ICE both compete with axum for
// tokio worker threads.  Over-provision to 8 so the HTTP server (axum)
// always has capacity even when GStreamer pipelines and ICE gatherers
// saturate the default (num_cpus = 4) pool.
#[tokio::main(worker_threads = 8)]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let port: u16 = std::env::args()
        .nth(1)
        .and_then(|p| p.parse().ok())
        .unwrap_or(0);
    gv_worker::run_worker(port).await
}
