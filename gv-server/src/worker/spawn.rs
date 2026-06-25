use std::sync::Arc;

use anyhow::{Context, Result};
use gv_shm::ShmRing;
use rand::{Rng, distributions::Alphanumeric};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};
use tokio_util::sync::CancellationToken;

use crate::platform;

use super::core::ensure_core;
use super::pid::{PORT_READ_TIMEOUT_SECS, pid_path, write_pid_file};

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
    pub(super) control_token: String,
    pub(super) game_id: String,
    pub(super) host_token: Option<String>,
    pub(super) child: Option<Child>,
    /// Shared-memory ring buffer for frame IPC from the worker.
    pub shm: Arc<ShmRing>,
    /// Cancel token signalled when the worker is killed — fan-out tasks
    /// and health monitors use child tokens to shut down cleanly.
    pub cancel_token: CancellationToken,
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
        // Signal fan-out tasks to stop
        self.cancel_token.cancel();

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
pub(crate) fn resolve_worker_bin(override_: Option<&str>) -> String {
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
/// Also creates a shared-memory ring buffer for frame IPC between
/// gv-server and gv-worker.  Frames flow from worker → shm → WebRTC tracks.
///
/// `worker_bin_override` — path to the worker binary.  Resolution order:
/// 1. This argument (from `config.toml` `gv_web.worker_bin`)
/// 2. `GV_WORKER_BIN` env var
/// 3. Auto-detect (`./target/release/gv-worker` → `./target/debug/gv-worker`)
///
/// `platform` — DAT platform string (e.g. "Nintendo - Game Boy").
/// Mapped to a core via `core_for_platform()` and passed as `GV_CORE_PATH`.
/// If `None` or unrecognized, the worker falls back to test pattern.
pub(crate) async fn spawn_worker(
    game_id: &str,
    worker_bin_override: Option<&str>,
    host_token: Option<&str>,
    content_path: Option<&str>,
    platform: Option<&str>,
    peer_tokens_json: Option<&str>,
) -> Result<SpawnedWorker> {
    let bin = resolve_worker_bin(worker_bin_override);

    // Create shared-memory ring buffer for frame IPC before spawning the worker.
    // The worker opens this segment (via --shm <name>) and writes encoded frames;
    // gv-server reads them and fans out to WebRTC tracks in-process.
    let shm_name = format!("gv-worker-{game_id}");
    let shm = Arc::new(
        gv_shm::ShmRing::create(&shm_name, gv_shm::DEFAULT_FRAME_COUNT)
            .with_context(|| format!("create shm ring '{shm_name}'"))?,
    );
    tracing::info!("[WORKER] created shm ring '{shm_name}'");

    let cancel_token = CancellationToken::new();

    // Pass port 0 — gv-worker binds a random available port and prints it
    let mut cmd = Command::new(&bin);
    cmd.arg("0");
    cmd.arg("--shm");
    cmd.arg(&shm_name);
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
        && let Some(core_file) = crate::platform::core_for_platform(plat) {
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
                    // If a game is being loaded (content_path is set), core failure
                    // means the worker can't play anything — don't spawn a useless worker.
                    if content_path.is_some() {
                        anyhow::bail!(
                            "core '{core_file}' not available for platform '{plat}' — {e}"
                        );
                    }
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

    // Wait for the "WORKER_READY" line (no port — worker has no HTTP server)
    let ready: bool = {
        let lines_seen = lines_seen.clone();
        tokio::time::timeout(
            std::time::Duration::from_secs(PORT_READ_TIMEOUT_SECS),
            async {
                loop {
                    match reader.next_line().await {
                        Ok(Some(line)) => {
                            tracing::info!("[WORKER] {line}");
                            lines_seen.lock().expect("lines_seen mutex poisoned").push(line.clone());
                            if line.contains("WORKER_READY") {
                                return true;
                            }
                        }
                        _ => return false,
                    }
                }
            },
        )
        .await
        .ok()
        .unwrap_or_else(|| {
            // Timeout — dump what we saw for debugging
            let seen: Vec<_> = lines_seen.lock().expect("lines_seen mutex poisoned").drain(..).collect();
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
            false
        })
    };

    if !ready {
        // Kill the child process before bailing — dropping a Child
        // does NOT kill the process, it only closes stdio handles.
        // Without this, a failed spawn leaks a zombie gv-worker.
        let _ = child.kill().await;
        let _ = child.wait().await;
        anyhow::bail!(
            "gv-worker didn't print WORKER_READY within {PORT_READ_TIMEOUT_SECS}s"
        );
    }

    // Spawn a background task to keep reading stderr (so child doesn't block)
    tokio::spawn(async move {
        while let Ok(Some(line)) = reader.next_line().await {
            tracing::info!("[WORKER] {line}");
        }
    });

    // Worker has no HTTP server in shm architecture — provide a placeholder
    // URL for gv-web readiness signaling (player polls until worker_url is set).
    let url = format!("http://gv-worker.local/{game_id}");
    Ok(SpawnedWorker {
        url,
        control_token,
        game_id: game_id.to_string(),
        host_token: host_token.map(|s| s.to_string()),
        child: Some(child),
        shm,
        cancel_token,
    })
}
