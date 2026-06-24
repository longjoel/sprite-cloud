use std::path::PathBuf;

// ── Constants (no magic values) ───────────────────────────────────────

/// How long to wait for gv-worker to print its port before giving up.
pub(super) const PORT_READ_TIMEOUT_SECS: u64 = 5;

/// Directory where PID files are written for crash recovery.
const WORKER_PID_DIR: &str = "/tmp/gv-workers";

/// Hostname reported in the connect URL.
/// Defaults to the LAN IP when available, falls back to localhost.
/// Set `GV_WORKER_HOST` to override.
pub(super) fn worker_host() -> String {
    std::env::var("GV_WORKER_HOST").unwrap_or_else(|_| {
        local_ip_address::local_ip()
            .map(|ip| ip.to_string())
            .unwrap_or_else(|_| "localhost".to_string())
    })
}

/// Rewrite a worker's public URL to a loopback URL that works from the server host.
/// Extracts the port from URLs like `http://192.168.86.126:3060`
/// and returns `http://127.0.0.1:{port}`.
pub(crate) fn internal_worker_url(public_url: &str) -> String {
    if let Some(colon) = public_url.rfind(':')
        && let Ok(port) = public_url[colon + 1..].parse::<u16>()
    {
        return format!("http://127.0.0.1:{port}");
    }
    public_url.to_string()
}

/// Path to the PID file for a given game_id.
pub(crate) fn pid_path(game_id: &str) -> PathBuf {
    PathBuf::from(WORKER_PID_DIR).join(format!("{game_id}.pid"))
}

pub(crate) fn write_pid_file(game_id: &str, pid: u32) {
    if let Err(e) = std::fs::create_dir_all(WORKER_PID_DIR) {
        tracing::warn!("[WORKER] create pid dir failed (non-fatal): {e}");
    } else if let Err(e) = std::fs::write(pid_path(game_id), pid.to_string()) {
        tracing::warn!("[WORKER] write pid file failed (non-fatal): {e}");
    }
}

// ── Reaper — kill stale workers from previous runs ────────────────────

/// Scan the PID directory for stale worker PID files, kill those
/// processes, and remove the files.
///
/// Called once at server startup to clean up orphans from a crash.
pub(crate) fn reap_stale_workers() {
    let dir = match std::fs::read_dir(WORKER_PID_DIR) {
        Ok(d) => d,
        Err(_) => return, // directory doesn't exist yet — nothing to reap
    };

    for entry in dir.flatten() {
        let path = entry.path();
        if path.extension().is_none_or(|e| e != "pid") {
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

        // Check process state — zombies have empty cmdline/comm.
        // We read /proc/<pid>/status for the State: field.
        let state = std::fs::read_to_string(format!("/proc/{pid}/status"))
            .ok()
            .and_then(|s| {
                s.lines()
                    .find(|l| l.starts_with("State:"))
                    .and_then(|l| l.split_whitespace().nth(1).map(|s| s.to_string()))
            });

        // Verify the PID belongs to a worker process.
        //
        // Only gv-worker processes are valid — the worker is always
        // a separate binary now (no more single-binary dispatch).
        // Zombies: can't verify via cmdline, but the process already exited.
        //   Just clean up the PID file and move on.
        let is_worker = if let Some(ref st) = state
            && st == "Z"
        {
            // Zombie process — already exited, identity was verified at spawn
            true
        } else {
            let comm_path = format!("/proc/{pid}/comm");
            if let Ok(comm) = std::fs::read_to_string(&comm_path) {
                comm.trim() == "gv-worker"
            } else {
                // /proc/<pid>/comm doesn't exist — process already dead
                false
            }
        };

        if !is_worker {
            tracing::warn!(
                "[REAPER] pid {pid} is not a worker — removing stale PID file"
            );
            let _ = std::fs::remove_file(&path);
            continue;
        }

        // Skip kill for zombies — they've already exited
        if let Some(ref st) = state
            && st == "Z"
        {
            tracing::info!(
                "[REAPER] zombie worker pid {pid} — removing PID file"
            );
            let _ = std::fs::remove_file(&path);
            continue;
        }

        // SAFETY: libc::kill is async-signal-safe. SIGTERM requests graceful
        // termination. We verified the process identity above.
        unsafe { libc::kill(pid as i32, libc::SIGTERM) };

        // Give it a moment, then SIGKILL if still alive
        std::thread::sleep(std::time::Duration::from_millis(500));
        // SAFETY: kill(pid, 0) is the POSIX way to check if a process exists.
        // We verified the comm matches gv-worker before sending signals.
        if unsafe { libc::kill(pid as i32, 0) } == 0 {
            // SAFETY: SIGKILL is async-signal-safe. Process identity was
            // verified before the first signal was sent.
            unsafe { libc::kill(pid as i32, libc::SIGKILL) };
            tracing::warn!(
                "[REAPER] force-killed stale worker pid {} ({})",
                pid,
                path.file_stem().unwrap_or_default().to_string_lossy()
            );
        } else {
            tracing::info!(
                "[REAPER] cleaned up stale pid file for {}",
                path.file_stem().unwrap_or_default().to_string_lossy()
            );
        }

        let _ = std::fs::remove_file(&path);
    }
}
