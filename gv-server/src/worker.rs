//! gv-worker process management.
//!
//! Spawns gv-worker as a child process, reads the bound port from
//! stderr, and returns the URL the browser should connect to.

use anyhow::{Context, Result};
use tokio::process::Command;
use tokio::io::{AsyncBufReadExt, BufReader};

// ── Constants (no magic values) ───────────────────────────────────────

/// Path to the gv-worker binary.
/// In dev: `./target/debug/gv-worker`.  Set `GV_WORKER_BIN` to override.
const DEFAULT_WORKER_BIN: &str = "./target/debug/gv-worker";

/// How long to wait for gv-worker to print its port before giving up.
const PORT_READ_TIMEOUT_SECS: u64 = 5;

/// Hostname reported in the connect URL.
/// Defaults to the LAN IP when available, falls back to localhost.
/// Set `GV_WORKER_HOST` to override.
fn worker_host() -> String {
    std::env::var("GV_WORKER_HOST").unwrap_or_else(|_| {
        // Try to find a non-loopback IPv4 address
        local_ip_address::local_ip()
            .map(|ip| ip.to_string())
            .unwrap_or_else(|_| "localhost".to_string())
    })
}

// ── Spawn ──────────────────────────────────────────────────────────────

/// Spawn a gv-worker on a random port and return the connect URL
/// (e.g., `"http://localhost:54321"`).
///
/// Reads stderr line-by-line until it finds the `open http://localhost:<port>`
/// line that gv-worker prints on startup.
pub async fn spawn_worker() -> Result<String> {
    let bin = std::env::var("GV_WORKER_BIN").unwrap_or_else(|_| DEFAULT_WORKER_BIN.to_string());

    // Pass port 0 — gv-worker binds a random available port and prints it
    let mut child = Command::new(&bin)
        .arg("0")
        .stderr(std::process::Stdio::piped())
        .spawn()
        .with_context(|| format!("spawn gv-worker at {bin}"))?;

    let stderr = child.stderr.take().context("no stderr pipe")?;
    let mut reader = BufReader::new(stderr).lines();

    // Wait for the "open http://localhost:<port>" line
    let port_line = tokio::time::timeout(
        std::time::Duration::from_secs(PORT_READ_TIMEOUT_SECS),
        async {
            loop {
                match reader.next_line().await {
                    Ok(Some(line)) => {
                        eprintln!("[WORKER] {}", line);
                        if line.contains("open http://localhost:") {
                            return Some(line);
                        }
                    }
                    _ => return None,
                }
            }
        },
    )
    .await
    .ok()
    .flatten()
    .context("gv-worker didn't print port within timeout")?;

    // Spawn a background task to keep reading stderr (so child doesn't block)
    tokio::spawn(async move {
        while let Ok(Some(line)) = reader.next_line().await {
            eprintln!("[WORKER] {}", line);
        }
    });

    // Don't await the child — it runs indefinitely
    // (we'll add lifecycle management later)

    // Parse port from the line
    let port: u16 = port_line
        .split("localhost:")
        .nth(1)
        .and_then(|s| s.trim().split_whitespace().next()?.parse().ok())
        .context("failed to parse port from worker startup line")?;

    Ok(format!("http://{}:{}", worker_host(), port))
}
