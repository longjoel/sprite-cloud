// Thin wrapper — all logic lives in the library crate.
// Reads port from args[1] for backward compat with gv-server spawn.

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let port: u16 = std::env::args()
        .nth(1)
        .and_then(|p| p.parse().ok())
        .unwrap_or(0);
    gv_worker::run_worker(port).await
}
