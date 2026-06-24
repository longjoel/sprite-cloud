use std::collections::HashSet;
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

/// Scan for stale gv-worker processes, kill them, and remove PID files.
///
/// Called once at server startup to clean up orphans from a crash. PID files
/// remain the primary inventory, but the live failure mode also left gv-worker
/// processes without PID files. Startup cleanup therefore scans `/proc` for
/// orphan `gv-worker` processes after processing the PID directory.
pub(crate) fn reap_stale_workers() {
    let mut pid_file_pids = HashSet::new();

    if let Ok(dir) = std::fs::read_dir(WORKER_PID_DIR) {
        reap_pid_file_workers(dir, &mut pid_file_pids);
    }

    reap_orphan_worker_processes(&pid_file_pids);
}

fn reap_pid_file_workers(dir: std::fs::ReadDir, pid_file_pids: &mut HashSet<u32>) {
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
        pid_file_pids.insert(pid);

        let state = process_state(pid);
        let is_worker = is_gv_worker_pid(pid, state.as_deref());

        if !is_worker {
            tracing::warn!(
                "[REAPER] pid {pid} is not a worker — removing stale PID file"
            );
            let _ = std::fs::remove_file(&path);
            continue;
        }

        // Skip kill for zombies — they've already exited. A non-child zombie
        // cannot be reaped by this process; removing the PID file prevents
        // future stale routing through this inventory entry.
        if matches!(state.as_deref(), Some("Z")) {
            tracing::info!(
                "[REAPER] zombie worker pid {pid} — removing PID file"
            );
            let _ = std::fs::remove_file(&path);
            continue;
        }

        if kill_stale_worker(pid) {
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

fn reap_orphan_worker_processes(pid_file_pids: &HashSet<u32>) {
    let proc_dir = match std::fs::read_dir("/proc") {
        Ok(d) => d,
        Err(e) => {
            tracing::warn!("[REAPER] cannot scan /proc for orphan workers: {e}");
            return;
        }
    };

    for entry in proc_dir.flatten() {
        let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        let Ok(pid) = name.parse::<u32>() else {
            continue;
        };
        if pid_file_pids.contains(&pid) {
            continue;
        }

        let state = process_state(pid);
        if !is_gv_worker_pid(pid, state.as_deref()) {
            continue;
        }

        if matches!(state.as_deref(), Some("Z")) {
            tracing::warn!(
                "[REAPER] orphan zombie gv-worker pid {pid} has no PID file; cannot reap non-child zombie"
            );
            continue;
        }

        if kill_stale_worker(pid) {
            tracing::warn!("[REAPER] force-killed orphan gv-worker pid {pid} without PID file");
        } else {
            tracing::info!("[REAPER] terminated orphan gv-worker pid {pid} without PID file");
        }
    }
}

fn process_state(pid: u32) -> Option<String> {
    std::fs::read_to_string(format!("/proc/{pid}/status"))
        .ok()
        .and_then(|s| {
            s.lines()
                .find(|line| line.starts_with("State:"))
                .and_then(|line| line.split_whitespace().nth(1).map(str::to_string))
        })
}

fn is_gv_worker_pid(pid: u32, state: Option<&str>) -> bool {
    if matches!(state, Some("Z")) {
        return true;
    }

    std::fs::read_to_string(format!("/proc/{pid}/comm"))
        .map(|comm| comm.trim() == "gv-worker")
        .unwrap_or(false)
}

fn kill_stale_worker(pid: u32) -> bool {
    // SAFETY: libc::kill is async-signal-safe. SIGTERM requests graceful
    // termination. Callers verify the PID belongs to gv-worker first.
    unsafe { libc::kill(pid as i32, libc::SIGTERM) };

    // Give it a moment, then SIGKILL if still alive.
    std::thread::sleep(std::time::Duration::from_millis(500));
    // SAFETY: kill(pid, 0) is the POSIX way to check if a process exists.
    if unsafe { libc::kill(pid as i32, 0) } == 0 {
        // SAFETY: SIGKILL is async-signal-safe. Process identity was verified
        // by the caller immediately before this function was invoked.
        unsafe { libc::kill(pid as i32, libc::SIGKILL) };
        true
    } else {
        false
    }
}
