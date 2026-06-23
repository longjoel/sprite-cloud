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
use rand::{Rng, distributions::Alphanumeric};
use std::path::PathBuf;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};

use crate::platform;

// ── Core mapping ──────────────────────────────────────────────────────

// Core mapping is now in `platform.rs` — aliased here for convenience.
pub use crate::platform::core_for_platform;

/// Resolve the full path to a core file.
///
/// Looks in `GV_CORES_DIR` (defaults to `./test-data/cores/` relative to
/// the worker binary, or `./cores/` as fallback).
fn resolve_core_path(core_filename: &str) -> PathBuf {
    let cores_dir = std::env::var("GV_CORES_DIR").unwrap_or_else(|_| {
        // Default: cores at workspace/test-data/cores/
        // CARGO_MANIFEST_DIR = <workspace>/gv-server → pop to workspace root
        let mut p = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        p.pop(); // → <workspace>
        p.push("test-data/cores");
        if p.exists() {
            return p.to_string_lossy().to_string();
        }
        // Fallback: <workspace>/cores/
        p.pop();
        p.pop();
        p.push("cores");
        p.to_string_lossy().to_string()
    });
    PathBuf::from(&cores_dir).join(core_filename)
}

// ── Automatic core download ───────────────────────────────────────────

/// Base URL for libretro buildbot nightly core downloads.
/// Override via `GV_BUILDBOT_URL` env var (e.g. for mirrors or stable channel).
static BUILDBOT_BASE: std::sync::LazyLock<String> = std::sync::LazyLock::new(|| {
    std::env::var("GV_BUILDBOT_URL")
        .unwrap_or_else(|_| "https://buildbot.libretro.com/nightly/linux/x86_64/latest".into())
});

/// Set of core filenames currently being downloaded.
/// Prevents concurrent duplicate downloads of the same core.
static DOWNLOADING: std::sync::LazyLock<std::sync::Mutex<std::collections::HashSet<String>>> =
    std::sync::LazyLock::new(|| std::sync::Mutex::new(std::collections::HashSet::new()));

/// Ensure a core `.so` file exists in the cores directory.
///
/// If the file is already present, returns its path immediately.
/// Otherwise downloads it from the buildbot, extracts it, and
/// returns the path.  Concurrent calls for the same core wait
/// for the first download to finish.
async fn ensure_core(core_filename: &str, client: &reqwest::Client) -> Result<PathBuf, String> {
    let core_path = resolve_core_path(core_filename);

    // Fast path: already cached
    if core_path.exists() {
        return Ok(core_path);
    }

    // Serialize downloads of the same core
    let already_downloading = {
        let mut inflight = DOWNLOADING
            .lock()
            .map_err(|e| format!("lock poisoned: {e}"))?;
        if inflight.contains(core_filename) {
            true
        } else {
            inflight.insert(core_filename.to_string());
            false
        }
    };

    if already_downloading {
        // Another task is downloading — poll until the file appears
        for _ in 0..60 {
            tokio::time::sleep(std::time::Duration::from_secs(1)).await;
            if core_path.exists() {
                return Ok(core_path);
            }
        }
        return Err("timed out waiting for concurrent core download".into());
    }

    // Download + extract
    let result = download_and_extract(core_filename, &core_path, client).await;

    // Remove from in-flight set
    {
        let mut inflight = DOWNLOADING.lock().map_err(|_| "lock poisoned")?;
        inflight.remove(core_filename);
    }

    result.map(|()| core_path)
}

/// Download a core zip from the buildbot and extract the `.so` file.
async fn download_and_extract(
    core_filename: &str,
    core_path: &PathBuf,
    client: &reqwest::Client,
) -> Result<(), String> {
    let zip_name = format!("{core_filename}.zip");
    let url = format!("{}/{}", *BUILDBOT_BASE, zip_name);

    tracing::info!("[CORE] downloading {url}");

    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("download {url}: {e}"))?;

    if !resp.status().is_success() {
        return Err(format!("download {url}: HTTP {}", resp.status()));
    }

    let bytes = resp.bytes().await.map_err(|e| format!("read body: {e}"))?;

    // Extract the single .so file
    let cursor = std::io::Cursor::new(bytes.as_ref());
    let mut archive = zip::ZipArchive::new(cursor).map_err(|e| format!("open zip: {e}"))?;

    if archive.len() != 1 {
        return Err(format!(
            "expected 1 file in {zip_name}, got {}",
            archive.len()
        ));
    }

    let mut entry = archive
        .by_index(0)
        .map_err(|e| format!("read zip entry: {e}"))?;
    let name = entry.name().to_string();

    if !name.ends_with(".so") || name.contains('/') {
        return Err(format!(
            "unexpected file in {zip_name}: {name} (expected {core_filename})"
        ));
    }

    // Ensure parent directory exists
    if let Some(parent) = core_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("create cores dir: {e}"))?;
    }

    // Write to a temp file first, then rename atomically
    let tmp_path = core_path.with_extension("tmp");
    let mut out =
        std::fs::File::create(&tmp_path).map_err(|e| format!("create {tmp_path:?}: {e}"))?;
    std::io::copy(&mut entry, &mut out).map_err(|e| format!("extract {name}: {e}"))?;
    drop(out);

    // Make executable
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&tmp_path, std::fs::Permissions::from_mode(0o755))
            .map_err(|e| format!("chmod +x {tmp_path:?}: {e}"))?;
    }

    std::fs::rename(&tmp_path, core_path)
        .map_err(|e| format!("rename {tmp_path:?} → {core_path:?}: {e}"))?;

    let size = std::fs::metadata(core_path).map(|m| m.len()).unwrap_or(0);
    tracing::info!("[CORE] installed {} ({} bytes)", core_path.display(), size);

    Ok(())
}

/// Test-only entry point for `ensure_core`.
#[doc(hidden)]
#[allow(dead_code)]
pub async fn ensure_core_for_test(
    core_filename: &str,
    client: &reqwest::Client,
) -> Result<PathBuf, String> {
    ensure_core(core_filename, client).await
}

// ── Constants (no magic values) ───────────────────────────────────────

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

fn write_pid_file(game_id: &str, pid: u32) {
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
pub fn reap_stale_workers() {
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

// ── SpawnedWorker ──────────────────────────────────────────────────────

fn generate_worker_control_token() -> String {
    rand::thread_rng()
        .sample_iter(&Alphanumeric)
        .take(32)
        .map(char::from)
        .collect()
}

/// A running gv-worker process with its connect URL and PID file.
///
/// # Cleanup
///
/// Call `kill()` before dropping to terminate the child and remove the
/// PID file.  Dropping without `kill()` leaves both the process and the
/// PID file behind (recovered by `reap_stale_workers()` on next startup).
pub struct SpawnedWorker {
    pub url: String,
    control_token: String,
    game_id: String,
    host_token: Option<String>,
    child: Option<Child>,
}

impl SpawnedWorker {
    pub fn control_token(&self) -> &str {
        &self.control_token
    }

    /// The host token that owns this worker (set via GV_HOST_TOKEN).
    pub fn host_token(&self) -> Option<&str> {
        self.host_token.as_deref()
    }

    /// The game ID used in the PID filename.
    pub fn game_id(&self) -> &str {
        &self.game_id
    }

    /// Reap the child if it has exited.
    ///
    /// `kill(pid, 0)` reports zombies as alive, so it is not a valid
    /// lifecycle check for workers.  Use `try_wait()` instead so exited
    /// children are reaped and removed from the process table.
    pub fn reap_if_exited(&mut self) -> bool {
        let Some(child) = self.child.as_mut() else {
            let _ = std::fs::remove_file(pid_path(&self.game_id));
            return true;
        };

        match child.try_wait() {
            Ok(Some(status)) => {
                tracing::warn!(
                    "[WORKER] worker for game {} exited: {}",
                    self.game_id,
                    status
                );
                self.child = None;
                let _ = std::fs::remove_file(pid_path(&self.game_id));
                true
            }
            Ok(None) => false,
            Err(e) => {
                tracing::warn!(
                    "[WORKER] failed to poll worker for game {}: {}",
                    self.game_id,
                    e
                );
                self.child = None;
                let _ = std::fs::remove_file(pid_path(&self.game_id));
                true
            }
        }
    }

    /// Kill the worker process gracefully, then forcefully.
    ///
    /// 1. POST /shutdown — triggers exit_signal, worker saves SRAM and exits
    /// 2. Wait up to 5s for the process to exit
    /// 3. If still running, SIGKILL
    pub async fn kill(mut self) {
        // Try graceful shutdown first
        if let Some(ref child) = self.child {
            let pid = child.id().unwrap_or(0);
            if pid > 0 {
                let shutdown_url = format!("{}/shutdown", self.url);
                if let Ok(client) = reqwest::Client::builder()
                    .timeout(std::time::Duration::from_secs(3))
                    .build()
                {
                    let _ = client
                        .post(&shutdown_url)
                        .bearer_auth(&self.control_token)
                        .send()
                        .await;
                }
                // Give the worker a moment to flush SRAM and exit
                tokio::time::sleep(std::time::Duration::from_secs(2)).await;
                // Check if it exited gracefully
                if unsafe { libc::kill(pid as i32, 0) } != 0 {
                    // Process already gone — clean exit
                    let _ = std::fs::remove_file(pid_path(&self.game_id));
                    return;
                }
            }
        }
        // Force kill if still alive
        if let Some(mut child) = self.child.take() {
            let _ = child.kill().await;
            let _ = child.wait().await;
        }
        let _ = std::fs::remove_file(pid_path(&self.game_id));
    }
}

impl Drop for SpawnedWorker {
    fn drop(&mut self) {
        if let Some(child) = self.child.take() {
            let pid = child.id().unwrap_or(0);
            // Drop the tokio handle so the inner std Child's fd is closed,
            // but the process lives on (we haven't waited yet).
            drop(child);
            if pid > 0 {
                // SAFETY: SIGKILL is async-signal-safe. The child is
                // a gv-worker process we spawned.
                unsafe { libc::kill(pid as i32, libc::SIGKILL) };
                // SAFETY: waitpid reaps the zombie. WNOHANG=0 blocks until
                // the process exits (which it will immediately — we SIGKILL'd it).
                unsafe { libc::waitpid(pid as i32, std::ptr::null_mut(), 0) };
            }
        }
        let _ = std::fs::remove_file(pid_path(&self.game_id));
    }
}

// ── Resolution ────────────────────────────────────────────────────────

/// Auto-detect the gv-worker binary (dev fallback).
fn default_worker_bin() -> String {
    let release = "./target/release/gv-worker";
    let debug = "./target/debug/gv-worker";
    if std::path::Path::new(release).exists() {
        release.to_string()
    } else {
        debug.to_string()
    }
}

/// Resolve the worker binary path.  Public for testing.
///
/// 1. `override` (from config.toml `gv_web.worker_bin`)
/// 2. `GV_WORKER_BIN` env var
/// 3. Auto-detect (`./target/release/gv-worker` → `./target/debug/gv-worker`)
pub fn resolve_worker_bin(override_: Option<&str>) -> String {
    if let Some(path) = override_ {
        return path.to_string();
    }
    if let Ok(path) = std::env::var("GV_WORKER_BIN") {
        return path;
    }
    default_worker_bin()
}

// ── Spawn ──────────────────────────────────────────────────────────────

/// Spawn a gv-worker on a random port and return a handle to it.
///
/// Writes a PID file to `/tmp/gv-workers/<game_id>.pid` for crash recovery.
///
/// Reads stderr line-by-line until it finds the `WORKER_READY port=<N>`
/// line that gv-worker prints on startup (structured contract).
///
/// The port number is parsed directly from the structured line —
/// no fragile string scraping.
///
/// `worker_bin_override` — path to the worker binary.  Resolution order:
/// 1. This argument (from `config.toml` `gv_web.worker_bin`)
/// 2. `GV_WORKER_BIN` env var
/// 3. Auto-detect (`./target/release/gv-worker` → `./target/debug/gv-worker`)
///
/// `platform` — DAT platform string (e.g. "Nintendo - Game Boy").
/// Mapped to a core via `core_for_platform()` and passed as `GV_CORE_PATH`.
/// If `None` or unrecognized, the worker falls back to test pattern.
pub async fn spawn_worker(
    game_id: &str,
    worker_bin_override: Option<&str>,
    host_token: Option<&str>,
    content_path: Option<&str>,
    platform: Option<&str>,
    peer_tokens_json: Option<&str>,
) -> Result<SpawnedWorker> {
    let bin = resolve_worker_bin(worker_bin_override);

    // Pass port 0 — gv-worker binds a random available port and prints it
    let mut cmd = Command::new(&bin);
    cmd.arg("0");
    cmd.stderr(std::process::Stdio::piped());

    // Bind to all interfaces so the health check and WebRTC media work
    // from other machines on the LAN (default is 127.0.0.1).
    cmd.env("GV_BIND_ADDR", "0.0.0.0");

    // Forward host token to the worker so it knows who's in charge.
    if let Some(token) = host_token {
        cmd.env("GV_HOST_TOKEN", token);
    }

    // Per-worker bearer token for HTTP control/debug endpoints.
    let control_token = generate_worker_control_token();
    cmd.env("GV_WORKER_CONTROL_TOKEN", &control_token);

    // Per-peer tokens for multi-peer WebRTC auth.
    if let Some(tokens) = peer_tokens_json {
        cmd.env("GV_PEER_TOKENS", tokens);
    }

    // Forward VP8 usage mode to the worker (0=good quality, 1=realtime).
    // Read from the server's own environment — set GV_VP8_USAGE=1 on
    // weak hardware (N100, RPi) for realtime encoding.
    if let Ok(usage) = std::env::var("GV_VP8_USAGE") {
        cmd.env("GV_VP8_USAGE", usage);
    }

    // Forward ROM path so the worker loads the right game
    if let Some(path) = content_path {
        tracing::info!("[WORKER] content_path={path}");
        cmd.env("GV_CONTENT_PATH", path);
    }

    // Map platform to a libretro core — download if missing
    if let Some(plat) = platform
        && let Some(core_file) = core_for_platform(plat) {
            // Build an HTTP client for core downloads
            let dl_client = reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(120))
                .build()
                .unwrap_or_default();

            match ensure_core(core_file, &dl_client).await {
                Ok(core_path) => {
                    tracing::info!(
                        "[WORKER] platform={plat} → core={core_file} ({})",
                        core_path.display()
                    );
                    cmd.env("GV_CORE_PATH", core_path);
                    // Set audio channel count from the platform manifest.
                    // Mono platforms (GB, GBC, NES, arcade) → 1ch.
                    // Stereo platforms (SNES, Genesis, N64) → 2ch.
                    // The worker reads GV_AUDIO_CHANNELS and configures
                    // Opus encoding accordingly. Falls back to 2 (stereo)
                    // for unknown platforms — stereo is always safe.
                    let channels = platform::channels_for_platform(plat);
                    cmd.env("GV_AUDIO_CHANNELS", channels.to_string());
                }
                Err(e) => {
                    tracing::warn!(
                        "[WORKER] core download failed for {core_file}: {e} — worker will use test pattern"
                    );
                }
            }
        }

    // Forward ICE (STUN/TURN) configuration to the worker for WebRTC.
    for key in &[
        "GV_ICE_STUN_URLS",
        "GV_ICE_TURN_URLS",
        "GV_ICE_TURN_USERNAME",
        "GV_ICE_TURN_CREDENTIAL",
        "GV_ICE_TRANSPORT_POLICY",
    ] {
        if let Ok(val) = std::env::var(key) {
            cmd.env(key, val);
        }
    }

    let mut child = cmd
        .spawn()
        .with_context(|| format!("spawn gv-worker at {bin}"))?;

    // Write PID file immediately so it exists even if we crash during port read
    let pid = child
        .id()
        .context("child process has no PID (already exited?)")?;
    write_pid_file(game_id, pid);

    let stderr = child.stderr.take().context("no stderr pipe")?;
    let mut reader = BufReader::new(stderr).lines();

    // Collect lines for diagnostics on timeout
    let lines_seen = std::sync::Arc::new(std::sync::Mutex::new(Vec::<String>::new()));

    // Wait for the "WORKER_READY port=<N>" line
    let port: u16 = {
        let lines_seen = lines_seen.clone();
        tokio::time::timeout(
            std::time::Duration::from_secs(PORT_READ_TIMEOUT_SECS),
            async {
                loop {
                    match reader.next_line().await {
                        Ok(Some(line)) => {
                            tracing::info!("[WORKER] {line}");
                            lines_seen.lock().unwrap().push(line.clone());
                            if let Some(rest) = line.strip_prefix("WORKER_READY port=") {
                                return rest.trim().parse().ok();
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
        .unwrap_or_else(|| {
            // Timeout — dump what we saw for debugging
            let seen: Vec<_> = lines_seen.lock().unwrap().drain(..).collect();
            if seen.is_empty() {
                tracing::error!(
                    "[WORKER] timeout after {PORT_READ_TIMEOUT_SECS}s — no stderr output from worker"
                );
            } else {
                tracing::error!(
                    "[WORKER] timeout after {PORT_READ_TIMEOUT_SECS}s — received lines:"
                );
                for line in &seen {
                    tracing::error!("[WORKER]   {line}");
                }
            }
            0
        })
    };

    if port == 0 {
        // Kill the child process before bailing — dropping a Child
        // does NOT kill the process, it only closes stdio handles.
        // Without this, a failed spawn leaks a zombie gv-worker.
        let _ = child.kill().await;
        let _ = child.wait().await;
        anyhow::bail!(
            "gv-worker didn't print WORKER_READY port=<N> within {PORT_READ_TIMEOUT_SECS}s"
        );
    }

    // Spawn a background task to keep reading stderr (so child doesn't block)
    tokio::spawn(async move {
        while let Ok(Some(line)) = reader.next_line().await {
            tracing::info!("[WORKER] {line}");
        }
    });

    let url = format!("http://{}:{}", worker_host(), port);
    Ok(SpawnedWorker {
        url,
        control_token,
        game_id: game_id.to_string(),
        host_token: host_token.map(|s| s.to_string()),
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
        write_pid_file(game_id, pid);

        let worker = SpawnedWorker {
            url: "http://localhost:9999".into(),
            control_token: "test-control-token".into(),
            game_id: game_id.into(),
            host_token: None,
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

    /// `reap_stale_workers()` must kill gv-worker processes with PID files still present.
    #[tokio::test]
    async fn reap_kills_stale_worker() {
        let game_id = "test-reap-1";
        let tmp = tempfile::tempdir().expect("tempdir");
        let fake_worker = tmp.path().join("gv-worker");
        std::os::unix::fs::symlink("/bin/sleep", &fake_worker).expect("symlink fake gv-worker");
        let child = Command::new(&fake_worker)
            .arg("60")
            .spawn()
            .expect("spawn fake gv-worker");

        let pid = child.id().expect("child has pid");

        write_pid_file(game_id, pid);

        // Drop the child handle — we're simulating a crash where the handle is lost.
        drop(child);

        reap_stale_workers();

        tokio::time::sleep(std::time::Duration::from_millis(600)).await;

        assert!(
            !is_process_alive(pid),
            "stale gv-worker should be killed by reaper"
        );
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

        write_pid_file(game_id, pid);

        reap_stale_workers();

        assert!(
            !pid_path(game_id).exists(),
            "PID file for dead process should be removed"
        );
    }

    /// Dropping a SpawnedWorker is a last-ditch cleanup path: it force-kills
    /// the child and removes the PID file if callers forgot `kill()`.
    #[tokio::test]
    async fn drop_kills_child_and_removes_pid_file() {
        let game_id = "test-drop-orphan";
        let child = Command::new("sleep")
            .arg("60")
            .spawn()
            .expect("spawn sleep");

        let pid = child.id().expect("child has pid");

        write_pid_file(game_id, pid);

        let worker = SpawnedWorker {
            url: "http://localhost:9999".into(),
            control_token: "test-control-token".into(),
            game_id: game_id.into(),
            host_token: None,
            child: Some(child),
        };

        drop(worker);

        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        assert!(
            !pid_path(game_id).exists(),
            "PID file should be removed on drop"
        );
        assert!(!is_process_alive(pid), "process should be killed on drop");
    }

    /// Check whether a process with `pid` is still running.
    fn is_process_alive(pid: u32) -> bool {
        unsafe { libc::kill(pid as i32, 0) == 0 }
    }

    // ── resolve_worker_bin tests ───────────────────────────────────

    /// config.toml override wins over everything.
    #[test]
    fn override_wins() {
        let path = resolve_worker_bin(Some("/opt/gv-worker"));
        assert_eq!(path, "/opt/gv-worker");
    }

    /// GV_WORKER_BIN env var wins over auto-detect.
    #[test]
    fn env_var_wins_over_auto_detect() {
        unsafe { std::env::set_var("GV_WORKER_BIN", "/tmp/test-gv-worker") };
        let path = resolve_worker_bin(None);
        assert_eq!(path, "/tmp/test-gv-worker");
        unsafe { std::env::remove_var("GV_WORKER_BIN") };
    }

    /// Auto-detect returns a valid path (dev build).
    #[test]
    fn auto_detect_returns_valid_path() {
        unsafe { std::env::remove_var("GV_WORKER_BIN") };
        let path = resolve_worker_bin(None);
        assert!(
            path == "./target/release/gv-worker"
                || path == "./target/debug/gv-worker",
            "expected release/debug path, got: {path}"
        );
    }

    // ── Core mapping table coverage ───────────────────────────────

    /// Every platform in the manifest that has extensions must have a
    /// core mapping (validates no accidental empty cores).
    #[test]
    fn every_scan_platform_has_core_mapping() {
        use crate::platform::PLATFORMS;

        let platforms: std::collections::HashSet<&str> =
            PLATFORMS.iter().map(|p| p.short_name).collect();

        let missing: Vec<_> = platforms
            .iter()
            .filter(|p| core_for_platform(p).is_none())
            .collect();

        assert!(
            missing.is_empty(),
            "PLATFORMS short_names without core mappings: {missing:?}"
        );
    }

    /// Full RetroArch DAT platform names covered.
    #[test]
    fn retroarch_dat_platforms_have_core_mapping() {
        let dat_platforms = &[
            "Nintendo - Game Boy",
            "Nintendo - Game Boy Color",
            "Nintendo - Game Boy Advance",
            "Nintendo - Nintendo Entertainment System",
            "Nintendo - Family Computer Disk System",
            "Nintendo - Super Nintendo Entertainment System",
            "Nintendo - Nintendo 64",
            "Nintendo - Nintendo DS",
            "Nintendo - Virtual Boy",
            "Nintendo - Pokemon Mini",
            "Sega - Mega Drive - Genesis",
            "Sega - Master System - Mark III",
            "Sega - Game Gear",
            "Sega - Sega CD - Mega CD",
            "Sega - Sega 32X",
            "Sega - Saturn",
            "Sega - Dreamcast",
            "Sony - PlayStation",
            "Sony - PlayStation Portable",
            "Atari - 2600",
            "Atari - 5200",
            "Atari - 7800",
            "Atari - Lynx",
            "NEC - PC Engine - TurboGrafx-16",
            "NEC - PC Engine CD - TurboGrafx-CD",
            "SNK - Neo Geo Pocket",
            "SNK - Neo Geo Pocket Color",
            "SNK - Neo Geo CD",
            "Bandai - WonderSwan",
            "Bandai - WonderSwan Color",
            "Arcade",
        ];

        let missing: Vec<_> = dat_platforms
            .iter()
            .filter(|p| core_for_platform(p).is_none())
            .collect();

        assert!(
            missing.is_empty(),
            "DAT platforms without core mappings: {missing:?}"
        );
    }

    /// First-match-wins: "Game Boy Advance" must not match "Game Boy".
    #[test]
    fn specific_platform_matches_before_broad() {
        assert_eq!(
            core_for_platform("Game Boy Advance"),
            Some("mgba_libretro.so")
        );
        assert_eq!(core_for_platform("Game Boy"), Some("mgba_libretro.so"));
    }
}
