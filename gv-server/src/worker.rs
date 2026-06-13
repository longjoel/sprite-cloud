//! gv-worker process management.
//!
//! Spawns gv-worker as a child process, reads the bound port from
//! stderr, and returns the URL the browser should connect to.
//!
//! # Crash recovery
//!
//! Every spawned worker writes a PID file to `/tmp/gv-workers/<game_id>.pid`.
//! `kill()` removes it on clean shutdown.  If the server crashes (SIGKILL,
//! OOM, power loss), `reap_stale_workers()` on the next startup finds and
//! kills orphaned processes.

use anyhow::{Context, Result};
use std::path::PathBuf;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};

// ── Constants (no magic values) ───────────────────────────────────────

/// Path to the gv-worker binary.
/// In dev: `./target/debug/gv-worker`.  Set `GV_WORKER_BIN` to override.
const DEFAULT_WORKER_BIN: &str = "./target/debug/gv-worker";

/// How long to wait for gv-worker to print its port before giving up.
const PORT_READ_TIMEOUT_SECS: u64 = 5;

/// Directory where PID files are written for crash recovery.
const WORKER_PID_DIR: &str = "/tmp/gv-workers";

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

/// Path to the PID file for a given game_id.
fn pid_path(game_id: &str) -> PathBuf {
    PathBuf::from(WORKER_PID_DIR).join(format!("{game_id}.pid"))
}

// ── Reaper — kill stale workers from previous runs ────────────────────

/// Scan the PID directory for stale worker PID files, kill those
/// processes, and remove the files.
///
/// Called once at server startup to clean up orphans from a crash.
pub fn reap_stale_workers() {
    let dir = match std::fs::read_dir(WORKER_PID_DIR) {
        Ok(d) => d,
        Err(_) => return, // directory doesn't exist yet — nothing to reap
    };

    for entry in dir.flatten() {
        let path = entry.path();
        if path.extension().map_or(true, |e| e != "pid") {
            continue;
        }

        let content = match std::fs::read_to_string(&path) {
            Ok(c) => c,
            Err(_) => {
                let _ = std::fs::remove_file(&path);
                continue;
            }
        };

        let pid: u32 = match content.trim().parse() {
            Ok(p) => p,
            Err(_) => {
                let _ = std::fs::remove_file(&path);
                continue;
            }
        };

        // Kill the process. Ignore errors — it may already be dead.
        unsafe { libc::kill(pid as i32, libc::SIGTERM) };

        // Give it a moment, then SIGKILL if still alive
        std::thread::sleep(std::time::Duration::from_millis(500));
        if unsafe { libc::kill(pid as i32, 0) } == 0 {
            unsafe { libc::kill(pid as i32, libc::SIGKILL) };
            eprintln!(
                "[REAPER] force-killed stale worker pid {} ({})",
                pid,
                path.file_stem().unwrap_or_default().to_string_lossy()
            );
        } else {
            eprintln!(
                "[REAPER] cleaned up stale pid file for {}",
                path.file_stem().unwrap_or_default().to_string_lossy()
            );
        }

        let _ = std::fs::remove_file(&path);
    }
}

// ── SpawnedWorker ──────────────────────────────────────────────────────

/// A running gv-worker process with its connect URL and PID file.
///
/// # Cleanup
///
/// Call `kill()` before dropping to terminate the child and remove the
/// PID file.  Dropping without `kill()` leaves both the process and the
/// PID file behind (recovered by `reap_stale_workers()` on next startup).
pub struct SpawnedWorker {
    pub url: String,
    game_id: String,
    child: Option<Child>,
}

impl SpawnedWorker {
    /// Kill the worker process, wait for it to exit, and remove the PID file.
    pub async fn kill(mut self) {
        if let Some(mut child) = self.child.take() {
            let _ = child.kill().await;
            let _ = child.wait().await;
        }
        let _ = std::fs::remove_file(pid_path(&self.game_id));
    }
}

// ── Spawn ──────────────────────────────────────────────────────────────

/// Spawn a gv-worker on a random port and return a handle to it.
///
/// Writes a PID file to `/tmp/gv-workers/<game_id>.pid` for crash recovery.
///
/// Reads stderr line-by-line until it finds the `open http://localhost:<port>`
/// line that gv-worker prints on startup.
pub async fn spawn_worker(game_id: &str) -> Result<SpawnedWorker> {
    let bin = std::env::var("GV_WORKER_BIN").unwrap_or_else(|_| DEFAULT_WORKER_BIN.to_string());

    // Pass port 0 — gv-worker binds a random available port and prints it
    let mut child = Command::new(&bin)
        .arg("0")
        .stderr(std::process::Stdio::piped())
        .spawn()
        .with_context(|| format!("spawn gv-worker at {bin}"))?;

    // Write PID file immediately so it exists even if we crash during port read
    let pid = child
        .id()
        .context("child process has no PID (already exited?)")?;
    std::fs::create_dir_all(WORKER_PID_DIR).context("create pid dir")?;
    std::fs::write(pid_path(game_id), pid.to_string()).context("write pid file")?;

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
        game_id: game_id.to_string(),
        child: Some(child),
    })
}

// ── Tests ──────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    /// `kill()` on a SpawnedWorker must terminate the child and remove the PID file.
    #[tokio::test]
    async fn kill_terminates_child_and_removes_pid_file() {
        let game_id = "test-kill-1";
        let child = Command::new("sleep")
            .arg("60")
            .spawn()
            .expect("spawn sleep");

        let pid = child.id().expect("child has pid");

        // Write a PID file manually (simulating what spawn_worker does)
        std::fs::create_dir_all(WORKER_PID_DIR).unwrap();
        std::fs::write(pid_path(game_id), pid.to_string()).unwrap();

        let worker = SpawnedWorker {
            url: "http://localhost:9999".into(),
            game_id: game_id.into(),
            child: Some(child),
        };

        worker.kill().await;

        // Give the OS a moment to reap
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;

        assert!(!is_process_alive(pid), "process should be dead");
        assert!(
            !pid_path(game_id).exists(),
            "PID file should be removed after kill()"
        );
    }

    /// `reap_stale_workers()` must kill processes with PID files still present.
    #[tokio::test]
    async fn reap_kills_stale_worker() {
        let game_id = "test-reap-1";
        let child = Command::new("sleep")
            .arg("60")
            .spawn()
            .expect("spawn sleep");

        let pid = child.id().expect("child has pid");

        std::fs::create_dir_all(WORKER_PID_DIR).unwrap();
        std::fs::write(pid_path(game_id), pid.to_string()).unwrap();

        // Drop the child handle — we're simulating a crash where the handle is lost
        drop(child);

        reap_stale_workers();

        tokio::time::sleep(std::time::Duration::from_millis(600)).await;

        assert!(!is_process_alive(pid), "stale worker should be killed by reaper");
        assert!(
            !pid_path(game_id).exists(),
            "PID file should be removed by reaper"
        );
    }

    /// `reap_stale_workers()` must clean up PID files for already-dead processes.
    #[tokio::test]
    async fn reap_removes_stale_pid_file_for_dead_process() {
        let game_id = "test-reap-dead";
        let pid = 99999; // almost certainly not running

        std::fs::create_dir_all(WORKER_PID_DIR).unwrap();
        std::fs::write(pid_path(game_id), pid.to_string()).unwrap();

        reap_stale_workers();

        assert!(
            !pid_path(game_id).exists(),
            "PID file for dead process should be removed"
        );
    }

    /// Dropping a SpawnedWorker without kill() leaves the PID file behind.
    #[tokio::test]
    async fn drop_without_kill_leaves_pid_file() {
        let game_id = "test-drop-orphan";
        let child = Command::new("sleep")
            .arg("60")
            .spawn()
            .expect("spawn sleep");

        let pid = child.id().expect("child has pid");

        std::fs::create_dir_all(WORKER_PID_DIR).unwrap();
        std::fs::write(pid_path(game_id), pid.to_string()).unwrap();

        let worker = SpawnedWorker {
            url: "http://localhost:9999".into(),
            game_id: game_id.into(),
            child: Some(child),
        };

        drop(worker);

        // PID file should still exist (proves reaper would find it)
        assert!(pid_path(game_id).exists(), "PID file should survive drop");
        assert!(is_process_alive(pid), "process should survive drop");

        // Clean up
        let _ = Command::new("kill").arg(pid.to_string()).output().await;
        let _ = std::fs::remove_file(pid_path(game_id));
    }

    /// Check whether a process with `pid` is still running.
    fn is_process_alive(pid: u32) -> bool {
        unsafe { libc::kill(pid as i32, 0) == 0 }
    }
}
