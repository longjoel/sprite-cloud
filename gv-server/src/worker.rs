//! gv-worker process management.
//!
//! Spawns gv-worker as a child process, reads the bound port from
//! stderr, and returns the URL the browser should connect to.
//!
//! The returned `SpawnedWorker` owns the child process handle —
//! dropping it without calling `kill()` leaves the worker running.
//! The caller must track workers and kill them on shutdown.

use anyhow::{Context, Result};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};

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
        local_ip_address::local_ip()
            .map(|ip| ip.to_string())
            .unwrap_or_else(|_| "localhost".to_string())
    })
}

// ── SpawnedWorker ──────────────────────────────────────────────────────

/// A running gv-worker process with its connect URL.
///
/// # Cleanup
///
/// Call `kill()` before dropping to ensure the child process is
/// terminated.  Dropping without `kill()` orphans the worker.
pub struct SpawnedWorker {
    pub url: String,
    child: Option<Child>,
}

impl SpawnedWorker {
    /// Kill the worker process and wait for it to exit.
    pub async fn kill(mut self) {
        if let Some(mut child) = self.child.take() {
            let _ = child.kill().await;
            let _ = child.wait().await;
        }
    }
}

// ── Spawn ──────────────────────────────────────────────────────────────

/// Spawn a gv-worker on a random port and return a handle to it.
///
/// Reads stderr line-by-line until it finds the `open http://localhost:<port>`
/// line that gv-worker prints on startup.
pub async fn spawn_worker() -> Result<SpawnedWorker> {
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

    // Parse port from the line
    let port: u16 = port_line
        .split("localhost:")
        .nth(1)
        .and_then(|s| s.trim().split_whitespace().next()?.parse().ok())
        .context("failed to parse port from worker startup line")?;

    let url = format!("http://{}:{}", worker_host(), port);

    Ok(SpawnedWorker {
        url,
        child: Some(child),
    })
}

// ── Tests ──────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    /// `kill()` on a SpawnedWorker that wraps a real process must terminate it.
    #[tokio::test]
    async fn kill_terminates_child() {
        // Spawn a long-running process (sleep) as a stand-in for gv-worker
        let child = Command::new("sleep")
            .arg("60")
            .spawn()
            .expect("spawn sleep");

        let pid = child.id().expect("child has pid");

        // Verify the process is alive
        assert!(is_process_alive(pid), "sleep process should be alive");

        let worker = SpawnedWorker {
            url: "http://localhost:9999".into(),
            child: Some(child),
        };

        worker.kill().await;

        // Give the OS a moment to reap
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;

        assert!(
            !is_process_alive(pid),
            "sleep process should be dead after kill()"
        );
    }

    /// Dropping a SpawnedWorker without calling kill() must NOT terminate the child.
    #[tokio::test]
    async fn drop_without_kill_orphans_child() {
        let child = Command::new("sleep")
            .arg("60")
            .spawn()
            .expect("spawn sleep");

        let pid = child.id().expect("child has pid");

        let worker = SpawnedWorker {
            url: "http://localhost:9999".into(),
            child: Some(child),
        };

        // Drop without calling kill()
        drop(worker);

        // Process should still be alive (orphaned, but alive)
        assert!(
            is_process_alive(pid),
            "sleep process should survive drop (orphaned)"
        );

        // Clean up
        let _ = Command::new("kill").arg(pid.to_string()).output().await;
    }

    /// Check whether a process with `pid` is still running.
    fn is_process_alive(pid: u32) -> bool {
        // Signal 0 is a no-op that only checks existence
        unsafe { libc::kill(pid as i32, 0) == 0 }
    }
}
