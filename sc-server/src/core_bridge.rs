//! Bridge between the libretro core (child process) and the tokio streaming loop.
//!
//! The core runs in a separate process (sc-core) for crash isolation.
//! If Nestopia segfaults, only the child dies — sc-server survives.
//!
//! IPC is via two /dev/shm buffers:
//!   - Output shm: core writes frames + audio, server reads
//!   - Input shm:  server writes commands, core reads
//!
//! A bridge thread reads from shm and forwards to the existing mpsc channels,
//! keeping the streaming loop and command handling completely unchanged.

use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::sync::mpsc;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;
// `ExitStatus::signal()` (for classifying child deaths like SIGSEGV/SIGABRT)
// is Unix-only. This crate targets Linux.
#[cfg(unix)]
use std::os::unix::process::ExitStatusExt;

use sc_core::{
    CMD_LOAD_SRAM, CMD_LOAD_STATE, CMD_SAVE_SRAM, CMD_SAVE_STATE, CMD_SET_INPUT, InputShm,
    OutputShm, map_shm, unlink_shm,
};

use crate::session::GameSession;

use crate::saves;

/// Request a fresh SRAM snapshot while the core process is still alive.
///
/// Clearing the prior response before publishing the command prevents a stale
/// save-state response from being mistaken for this SRAM acknowledgement.
fn request_sram_snapshot<F>(
    input: &InputShm,
    output: &OutputShm,
    mut child_alive: F,
    timeout: Duration,
) -> Option<Vec<u8>>
where
    F: FnMut() -> bool,
{
    let deadline = std::time::Instant::now() + timeout;
    // Do not overwrite a command that the core has already acquired. Waiting
    // here also prevents that earlier command's acknowledgement from being
    // mistaken for the SRAM request below.
    while input.cmd_ready.load(Ordering::Acquire) {
        if !child_alive() || std::time::Instant::now() >= deadline {
            return None;
        }
        std::thread::sleep(Duration::from_millis(1));
    }

    output.response_ok.store(false, Ordering::Relaxed);
    output.response_data_len.store(0, Ordering::Relaxed);
    input.cmd_type.store(CMD_SAVE_SRAM, Ordering::Relaxed);
    input.cmd_ready.store(true, Ordering::Release);

    while input.cmd_ready.load(Ordering::Acquire) {
        if !child_alive() || std::time::Instant::now() >= deadline {
            return None;
        }
        std::thread::sleep(Duration::from_millis(1));
    }

    if !output.response_ok.load(Ordering::Relaxed) {
        return None;
    }
    let len = output.response_data_len.load(Ordering::Relaxed) as usize;
    if len == 0 {
        return None;
    }
    Some(output.response_data[..len.min(sc_core::MAX_RESPONSE)].to_vec())
}

trait CoreChildLifecycle {
    fn is_alive(&mut self) -> bool;
    fn terminate(&mut self);
}

impl CoreChildLifecycle for std::process::Child {
    fn is_alive(&mut self) -> bool {
        matches!(self.try_wait(), Ok(None))
    }

    fn terminate(&mut self) {
        let _ = self.kill();
        let _ = self.wait();
    }
}

struct CoreShutdownCompletion(Option<tokio_util::sync::CancellationToken>);

impl CoreShutdownCompletion {
    fn registered_in(
        registry: &CoreBridgeShutdownRegistry,
        cancel: tokio_util::sync::CancellationToken,
        stopped: tokio_util::sync::CancellationToken,
    ) -> Self {
        registry.register(cancel, stopped.clone());
        Self(Some(stopped))
    }

    fn registered(
        cancel: tokio_util::sync::CancellationToken,
        stopped: tokio_util::sync::CancellationToken,
    ) -> Self {
        Self::registered_in(core_bridge_shutdown_registry(), cancel, stopped)
    }

    fn complete(mut self) {
        if let Some(stopped) = self.0.take() {
            stopped.cancel();
        }
    }
}

impl Drop for CoreShutdownCompletion {
    fn drop(&mut self) {
        if self.0.is_some() {
            tracing::error!("[BRIDGE] shutdown completion guard dropped before cleanup completed");
        }
    }
}

#[derive(Clone)]
struct CoreBridgeShutdownHandle {
    cancel: tokio_util::sync::CancellationToken,
    stopped: tokio_util::sync::CancellationToken,
}

#[derive(Default)]
struct CoreBridgeShutdownRegistry {
    handles: Mutex<Vec<CoreBridgeShutdownHandle>>,
}

impl CoreBridgeShutdownRegistry {
    fn register(
        &self,
        cancel: tokio_util::sync::CancellationToken,
        stopped: tokio_util::sync::CancellationToken,
    ) {
        let mut handles = self
            .handles
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        handles.retain(|handle| !handle.stopped.is_cancelled());
        handles.push(CoreBridgeShutdownHandle { cancel, stopped });
    }

    async fn cancel_and_wait(&self, timeout: Duration) -> bool {
        let handles = {
            let mut handles = self
                .handles
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            handles.retain(|handle| !handle.stopped.is_cancelled());
            handles.clone()
        };

        for handle in &handles {
            handle.cancel.cancel();
        }

        let completed = tokio::time::timeout(timeout, async {
            for handle in &handles {
                handle.stopped.cancelled().await;
            }
        })
        .await
        .is_ok();

        if completed {
            self.handles
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .retain(|handle| !handle.stopped.is_cancelled());
        }
        completed
    }
}

fn core_bridge_shutdown_registry() -> &'static CoreBridgeShutdownRegistry {
    static REGISTRY: OnceLock<CoreBridgeShutdownRegistry> = OnceLock::new();
    REGISTRY.get_or_init(CoreBridgeShutdownRegistry::default)
}

/// Cancel every bridge started by this process and wait under one global
/// deadline. The registry is independent of active session maps, so a bridge
/// remains observable while stop/disconnect cleanup is saving SRAM.
pub(crate) async fn shutdown_all_core_bridges(timeout: Duration) -> bool {
    core_bridge_shutdown_registry()
        .cancel_and_wait(timeout)
        .await
}

/// Cancel one core bridge and wait until SRAM capture, child termination, and
/// shared-memory cleanup have completed. Callers must not start a replacement
/// for the same game until this barrier succeeds.
pub(crate) async fn cancel_and_wait_for_core(
    cancel: &tokio_util::sync::CancellationToken,
    stopped: &tokio_util::sync::CancellationToken,
    timeout: Duration,
) -> bool {
    cancel.cancel();
    tokio::time::timeout(timeout, stopped.cancelled())
        .await
        .is_ok()
}

/// Deliver a core frame without allowing a slow/stopped async consumer to pin
/// the bridge thread forever. A full one-frame channel means the consumer has
/// not drained the previous frame yet; dropping this frame is correct for a
/// real-time stream and leaves cancellation observable.
fn deliver_latest_frame(sender: &mpsc::SyncSender<CoreFrame>, frame: CoreFrame) -> bool {
    match sender.try_send(frame) {
        Ok(()) | Err(mpsc::TrySendError::Full(_)) => true,
        Err(mpsc::TrySendError::Disconnected(_)) => false,
    }
}

/// Deliver the zero-size core-crash sentinel without letting it be dropped by
/// a full single-slot channel, and do it *before* cancellation is signalled.
///
/// Unlike `deliver_latest_frame`, a crash must not be loseable: the streaming
/// loop depends on seeing the width-0 sentinel to relay `core_died` to the
/// player. The one-frame channel can legitimately hold a normal frame when the
/// core dies, so `try_send` may report Full; the consumer drains that slot on
/// its next ~frame-interval tick, so a short bounded retry lands the sentinel.
/// We give up (letting cancellation dominate) only if the consumer is gone —
/// in which case there is no stream left to notify.
fn deliver_crash_sentinel(sender: &mpsc::SyncSender<CoreFrame>) -> bool {
    let sentinel = CoreFrame {
        pixels: Vec::new(),
        width: 0,
        height: 0,
        audio: Vec::new(),
    };
    let deadline = std::time::Instant::now() + Duration::from_millis(200);
    loop {
        match sender.try_send(sentinel.clone()) {
            Ok(()) => return true,
            Err(mpsc::TrySendError::Full(_)) if std::time::Instant::now() < deadline => {
                // The streaming loop drains the single slot each tick; retry
                // briefly so the sentinel wins over whatever live frame filled it.
                std::thread::sleep(Duration::from_millis(5));
            }
            Err(mpsc::TrySendError::Full(_)) => return false,
            Err(mpsc::TrySendError::Disconnected(_)) => return false,
        }
    }
}

/// How long an *alive* core may go without delivering a single video frame
/// before we declare it stalled and surface a graceful error instead of
/// leaving the player on a frozen/test-pattern stream forever. Broken core
/// builds (e.g. a libretro core whose video_refresh never fires) boot, spin,
/// and stay alive without ever presenting a frame; this watchdog catches that.
/// 45s is generous enough not to false-positive on a slow first frame while
/// catching genuinely-stuck cores well before a user gives up.
const CORE_STALL_GRACE: Duration = Duration::from_secs(45);

/// Map a child `ExitStatus` plus captured stderr to a concise, player-facing
/// reason for `core_died`. `ExitStatus::signal()` is `Some` when the child was
/// terminated by a signal (a C++ abort like flycast's `SH4ThrownException`
/// surfaces as SIGABRT; a segfault as SIGSEGV), `code()` some when it exited
/// normally with a code (137 = SIGKILL, typically the OOM-killer). Differentiating
/// them is what lets the player show *why* the stream died instead of the
/// generic "core process crashed". A short stderr tail is appended as a hint.
fn classify_core_death(status: &std::process::ExitStatus, stderr_tail: &str) -> String {
    // Standard Linux signal numbers (no libc dep in this crate).
    const SIGABRT: i32 = 6;
    const SIGBUS: i32 = 7;
    const SIGKILL: i32 = 9;
    const SIGSEGV: i32 = 11;
    const SIGILL: i32 = 4;

    let stderr_hint = {
        let tail = stderr_tail.trim();
        if tail.is_empty() {
            String::new()
        } else {
            let shown: String = tail.chars().take(140).collect();
            format!(" ({})", shown.replace('\n', " ").replace('\r', ""))
        }
    };

    if let Some(code) = status.code() {
        match code {
            0 => format!("Emulator exited unexpectedly{stderr_hint}"),
            101 => format!("Emulator panicked (unhandled Rust panic){stderr_hint}"),
            137 => format!("Emulator was killed — likely out of memory{stderr_hint}"),
            _ => format!("Emulator crashed (exit code {code}){stderr_hint}"),
        }
    } else if let Some(sig) = status.signal() {
        match sig {
            SIGSEGV => format!(
                "Emulator crashed — segmentation fault{stderr_hint}"
            ),
            SIGABRT => format!(
                "Emulator aborted — the game or emulator raised an unhandled exception{stderr_hint}"
            ),
            SIGBUS => format!("Emulator crashed — bus error{stderr_hint}"),
            SIGILL => format!("Emulator crashed — illegal instruction{stderr_hint}"),
            SIGKILL => format!("Emulator was killed (SIGKILL — likely out of memory){stderr_hint}"),
            _ => format!("Emulator crashed (signal {sig}){stderr_hint}"),
        }
    } else {
        format!("Emulator crashed{stderr_hint}")
    }
}

#[cfg(test)]
mod classify_core_death_tests {
    use super::*;
    use std::os::unix::process::ExitStatusExt;

    // Build an `ExitStatus` as the kernel reports it via waitpid raw status:
    // normal exits store the code in the high byte (code << 8); signal deaths
    // store the signal number in the low byte.
    fn exited(code: i32) -> std::process::ExitStatus {
        std::process::ExitStatus::from_raw(code << 8)
    }
    fn signaled(sig: i32) -> std::process::ExitStatus {
        std::process::ExitStatus::from_raw(sig)
    }

    #[test]
    fn maps_normal_exit_codes() {
        assert!(classify_core_death(&exited(0), "").contains("exited unexpectedly"));
        // 137 = 128 + SIGKILL, the shell/OOM-killer convention.
        assert!(classify_core_death(&exited(137), "").contains("out of memory"));
        assert!(classify_core_death(&exited(1), "").contains("exit code 1"));
    }

    #[test]
    fn maps_signal_deaths_to_plain_reasons() {
        // The core crashing with a segfault → "segmentation fault".
        assert!(classify_core_death(&signaled(11), "").contains("segmentation fault"));
        // flycast's SH4ThrownException surfaces as std::terminate → SIGABRT(6).
        assert!(classify_core_death(&signaled(6), "").contains("unhandled exception"));
        assert!(classify_core_death(&signaled(9), "").contains("out of memory"));
    }

    #[test]
    fn includes_a_short_stderr_tail_as_a_hint() {
        let reason = classify_core_death(&signaled(6), "terminate called after throwing\nsome detail");
        assert!(reason.contains("unhandled exception"));
        assert!(reason.contains("some detail"));
    }

    #[test]
    fn empty_stderr_adds_no_hint() {
        let reason = classify_core_death(&signaled(11), "  \n  ");
        assert!(!reason.contains('('));
    }
}

/// Run bridge work and always invoke its shutdown lifecycle, even when the
/// processing loop panics. The panic is contained so SRAM capture and child
/// termination can complete before the daemon observes bridge completion.
fn run_and_shutdown_after_panic<T, R, S>(state: &mut T, run: R, shutdown: S) -> bool
where
    R: FnOnce(&mut T),
    S: FnOnce(&mut T),
{
    let panicked = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| run(state))).is_err();
    shutdown(state);
    panicked
}

/// Capture and persist current SRAM before terminating the core child.
/// Keeping this ordering in one testable operation prevents shutdown cleanup
/// from silently moving ahead of the final battery-save acknowledgement.
fn capture_sram_and_terminate<C, P>(
    child: &mut C,
    input: &InputShm,
    output: &OutputShm,
    rom_hash: Option<&str>,
    timeout: Duration,
    mut persist: P,
) where
    C: CoreChildLifecycle,
    P: FnMut(&str, &[u8]),
{
    if let Some(hash) = rom_hash {
        let snapshot = request_sram_snapshot(input, output, || child.is_alive(), timeout);
        if let Some(data) = snapshot {
            persist(hash, &data);
        } else {
            tracing::warn!("[SRAM] no fresh shutdown snapshot available");
        }
    }
    child.terminate();
}

// ── Zip extraction helper ──────────────────────────────────────────────

/// Extract the first ROM file from a .zip archive to a temp file.
/// Caches by game_id in /tmp/sc-workers/. Second play skips extraction entirely.
/// Arcade platforms (FBNeo) use the .zip as-is — the core reads the full
/// ROM set directly from the archive.
fn ensure_extracted_rom(rom_path: &str, game_id: &str, platform: Option<&str>) -> String {
    let path = std::path::Path::new(rom_path);
    if !path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.eq_ignore_ascii_case("zip"))
        .unwrap_or(false)
    {
        return rom_path.to_string();
    }

    // Arcade / FBNeo ROMs are multi-file sets inside .zip — the core
    // reads the full archive, so extracting a single entry breaks it.
    if platform == Some("Arcade") {
        tracing::info!("[CORE] arcade zip passed through as-is: {}", rom_path);
        return rom_path.to_string();
    }

    // ── Cache check: skip extraction if already done ─────────────────
    let cache_dir = std::path::PathBuf::from("/tmp/sc-workers");
    let _ = std::fs::create_dir_all(&cache_dir);
    if let Ok(entries) = std::fs::read_dir(&cache_dir) {
        for entry in entries.flatten() {
            let fname = entry.file_name();
            let fname = fname.to_string_lossy();
            if fname.starts_with(game_id) && !fname.ends_with(".tmp") {
                let cached = entry.path();
                if cached.is_file() && cached.metadata().map(|m| m.len() > 0).unwrap_or(false) {
                    tracing::info!("[CORE] using cached ROM: {}", cached.display());
                    return cached.to_string_lossy().to_string();
                }
            }
        }
    }

    // ── Extract from zip ─────────────────────────────────────────────
    let file = match std::fs::File::open(path) {
        Ok(f) => f,
        Err(e) => {
            tracing::warn!("[CORE] zip extraction: cannot open {}: {e}", rom_path);
            return rom_path.to_string();
        }
    };
    let mut archive = match zip::ZipArchive::new(std::io::BufReader::new(file)) {
        Ok(a) => a,
        Err(e) => {
            tracing::warn!("[CORE] zip extraction: cannot read zip {}: {e}", rom_path);
            return rom_path.to_string();
        }
    };

    let rom_exts = [
        "nes", "sfc", "smc", "gb", "gbc", "gba", "gen", "md", "smd", "a26", "a52", "a78", "lnx",
        "n64", "z64", "v64", "nds", "vb", "sms", "gg", "32x", "pce", "ngp", "ngc", "ws", "wsc",
        "iso", "cue", "cso", "fds", "min", "mdf", "cdi", "gdi",
    ];

    let mut best_idx: Option<usize> = None;

    for i in 0..archive.len() {
        let Ok(entry) = archive.by_index(i) else {
            continue;
        };
        if entry.is_dir() {
            continue;
        }
        let name = entry.name().to_lowercase();
        if best_idx.is_none() {
            best_idx = Some(i);
        }
        let ext = std::path::Path::new(&name)
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("");
        if rom_exts.contains(&ext) {
            best_idx = Some(i);
            break;
        }
    }

    if let Some(idx) = best_idx {
        if let Ok(mut entry) = archive.by_index(idx) {
            let inner_name = entry.name();
            let inner_ext = std::path::Path::new(inner_name)
                .extension()
                .and_then(|e| e.to_str())
                .unwrap_or("bin");
            let tmp_dir = std::path::PathBuf::from("/tmp/sc-workers");
            let _ = std::fs::create_dir_all(&tmp_dir);
            // Use game_id for clean filename (avoids spaces/parens/special chars)
            let tmp_path = tmp_dir.join(format!("{game_id}.{inner_ext}"));
            match std::fs::File::create(&tmp_path) {
                Ok(mut out) => match std::io::copy(&mut entry, &mut out) {
                    Ok(_) => {
                        tracing::info!("[CORE] extracted {} → {}", rom_path, tmp_path.display());
                        return tmp_path.to_string_lossy().to_string();
                    }
                    Err(e) => {
                        tracing::warn!("[CORE] zip extraction: copy failed {}: {e}", rom_path);
                    }
                },
                Err(e) => {
                    tracing::warn!(
                        "[CORE] zip extraction: cannot create tmp file {}: {e}",
                        tmp_path.display()
                    );
                }
            }
        } else {
            tracing::warn!(
                "[CORE] zip extraction: cannot read entry at index {idx} from {rom_path}"
            );
        }
    } else {
        tracing::warn!("[CORE] zip extraction: no entries found in {}", rom_path);
    }
    rom_path.to_string()
}

// ── Core download (unchanged) ──────────────────────────────────────

fn resolve_system_dir() -> String {
    if let Ok(dir) = std::env::var("GV_SYSTEM_DIR") {
        let dir = dir.trim().to_string();
        if !dir.is_empty() {
            return dir;
        }
    }
    CONFIGURED_SYSTEM_DIR
        .get()
        .cloned()
        .unwrap_or_else(|| "/tmp".into())
}

static CONFIGURED_CORES_DIR: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();
static CONFIGURED_SYSTEM_DIR: std::sync::OnceLock<String> = std::sync::OnceLock::new();

pub fn configure_cores_dir(path: &str) {
    if !path.trim().is_empty() {
        let _ = CONFIGURED_CORES_DIR.set(PathBuf::from(path));
    }
}

pub fn configure_system_dir(path: &str) {
    if !path.trim().is_empty() {
        let _ = CONFIGURED_SYSTEM_DIR.set(path.to_string());
    }
}

fn resolve_core_path(core_filename: &str) -> PathBuf {
    let cores_dir = std::env::var("GV_CORES_DIR")
        .ok()
        .map(PathBuf::from)
        .or_else(|| CONFIGURED_CORES_DIR.get().cloned())
        .unwrap_or_else(|| {
            let mut p = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
            p.pop();
            p.push("test-data/cores");
            if p.exists() {
                return p;
            }
            p.pop();
            p.pop();
            p.push("cores");
            p
        });
    cores_dir.join(core_filename)
}

static BUILDBOT_BASE: std::sync::LazyLock<String> = std::sync::LazyLock::new(|| {
    std::env::var("GV_BUILDBOT_URL")
        .unwrap_or_else(|_| "https://buildbot.libretro.com/nightly/linux/x86_64/latest".into())
});

static DOWNLOADING: std::sync::LazyLock<std::sync::Mutex<std::collections::HashSet<String>>> =
    std::sync::LazyLock::new(|| std::sync::Mutex::new(std::collections::HashSet::new()));

pub async fn ensure_core(core_filename: &str, client: &reqwest::Client) -> Result<PathBuf, String> {
    let core_path = resolve_core_path(core_filename);
    if core_path.exists() {
        return Ok(core_path);
    }

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
        for _ in 0..60 {
            tokio::time::sleep(std::time::Duration::from_secs(1)).await;
            if core_path.exists() {
                return Ok(core_path);
            }
        }
        return Err("timed out waiting for concurrent core download".into());
    }

    let result = download_and_extract(core_filename, &core_path, client).await;
    {
        let mut inflight = DOWNLOADING.lock().map_err(|_| "lock poisoned")?;
        inflight.remove(core_filename);
    }
    result.map(|()| core_path)
}

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

    if let Some(parent) = core_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("create cores dir: {e}"))?;
    }

    let tmp_path = core_path.with_extension("tmp");
    let mut out =
        std::fs::File::create(&tmp_path).map_err(|e| format!("create {tmp_path:?}: {e}"))?;
    std::io::copy(&mut entry, &mut out).map_err(|e| format!("extract {name}: {e}"))?;
    drop(out);

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

// ── Frame + command types (unchanged) ──────────────────────────────

#[derive(Clone)]
pub struct CoreFrame {
    pub pixels: Vec<u8>,
    #[allow(dead_code)]
    pub width: u32,
    #[allow(dead_code)]
    pub height: u32,
    pub audio: Vec<i16>,
}

pub enum CoreCommand {
    SetInput {
        port: u32,
        state: u16,
        /// Analog stick axes, signed -127..127 (0 = centered).
        ax: i8,
        ay: i8,
    },
    SaveState,
    LoadState { data: Vec<u8> },
}

pub enum CoreResponse {
    SaveStateResult { data: Vec<u8>, ok: bool },
    LoadStateResult { ok: bool },
}

// ── sc-core binary location ────────────────────────────────────────

fn find_sc_core_binary() -> PathBuf {
    // Check env var first
    if let Ok(p) = std::env::var("GV_CORE_BIN") {
        let path = PathBuf::from(&p);
        if path.exists() {
            return path;
        }
    }
    // Check next to sc-server binary
    if let Ok(exe) = std::env::current_exe() {
        let sibling = exe.with_file_name("sc-core");
        if sibling.exists() {
            return sibling;
        }
    }
    // Check debug/release target dirs (cargo workspace root)
    let mut target = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    target.pop(); // sc-server → workspace root
    for profile in &["release", "debug"] {
        let p = target.join("target").join(profile).join("sc-core");
        if p.exists() {
            return p;
        }
    }
    // Fallback
    PathBuf::from("sc-core")
}

// ── Child process management ───────────────────────────────────────

/// Load a libretro core by spawning sc-core child process.
/// Keeps the same interface as the old in-process load — channels are
/// populated the same way. Streaming loop + command handling unchanged.
pub async fn load_core_into_session(
    session: &Arc<GameSession>,
    core_path: Option<&std::path::Path>,
    content_path: Option<&str>,
    platform: Option<&str>,
) -> Result<(), String> {
    struct LoadingGuard<'a>(&'a std::sync::atomic::AtomicBool);
    impl Drop for LoadingGuard<'_> {
        fn drop(&mut self) {
            self.0.store(false, Ordering::Release);
        }
    }

    session.core_loading.store(true, Ordering::Release);
    let _loading_guard = LoadingGuard(&session.core_loading);
    let game_id = &session.game_id;

    // Mono-hardware platforms get the live audio channel mirrored into both
    // in sc-core, so a core that outputs mono one-sided can never stream
    // one-channel audio (see libretro_runner::normalize_mono).
    let mono_flag = platform
        .map(crate::platform::platform_is_mono)
        .unwrap_or(false);

    let core_path_str = match core_path {
        Some(p) => p.to_string_lossy().to_string(),
        None => std::env::var("GV_CORE_PATH").unwrap_or_else(|_| {
            let mut p = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"));
            p.pop();
            p.push("test-data/cores/2048_libretro.so");
            p.to_string_lossy().to_string()
        }),
    };

    let rom_path = content_path.unwrap_or("");
    // Extract zip ROMs so sc-core gets raw ROM data — except Arcade
    // (FBNeo) where the zip IS the ROM set and must be passed whole.
    let actual_rom_path = ensure_extracted_rom(rom_path, game_id, platform);
    let out_name = format!("sc-out-{game_id}");
    let in_name = format!("sc-in-{game_id}");

    // Create shm
    let out_mmap = match map_shm::<OutputShm>(&out_name, OutputShm::size()) {
        Ok(m) => m,
        Err(e) => {
            tracing::error!("[CORE] out shm: {e}");
            return Err(format!("create output shared memory: {e}"));
        }
    };
    let in_mmap = match map_shm::<InputShm>(&in_name, InputShm::size()) {
        Ok(m) => m,
        Err(e) => {
            tracing::error!("[CORE] in shm: {e}");
            unlink_shm(&out_name);
            return Err(format!("create input shared memory: {e}"));
        }
    };

    let out: &OutputShm = unsafe { &*(out_mmap.as_ptr() as *const OutputShm) };
    let inp: &InputShm = unsafe { &*(in_mmap.as_ptr() as *const InputShm) };

    // Find sc-core binary
    let core_bin = find_sc_core_binary();
    let system_dir = resolve_system_dir();
    tracing::info!(
        "[CORE] spawning {} {} {} {} {}",
        core_bin.display(),
        core_path_str,
        actual_rom_path,
        out_name,
        in_name
    );
    tracing::info!("[CORE] system_dir={}", system_dir);

    let mut spawn_args: Vec<&str> = vec![
        &core_path_str,
        &actual_rom_path,
        &out_name,
        &in_name,
        &system_dir,
    ];
    if mono_flag {
        spawn_args.push("mono");
        tracing::info!("[CORE] mono platform — audio channel mirroring enabled");
    }

    let mut child = match std::process::Command::new(&core_bin)
        .args(&spawn_args)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .spawn()
    {
        Ok(c) => c,
        Err(e) => {
            tracing::error!("[CORE] spawn sc-core: {e}");
            unlink_shm(&out_name);
            unlink_shm(&in_name);
            return Err(format!("spawn sc-core: {e}"));
        }
    };

    // Wait for metadata (core reports dimensions before frame loop).
    // 180 × 100ms = 18s: heavyweight cores (PPSSPP etc.) can take several
    // seconds to boot past their intro media and report real geometry.
    let mut width: u32 = 0;
    let mut height: u32 = 0;
    let mut fps: f64 = 0.0;
    let mut core_sample_rate: f64 = 48000.0;
    for _ in 0..180 {
        let bw = out.base_width.load(Ordering::Relaxed);
        let bh = out.base_height.load(Ordering::Relaxed);
        let fx = out.fps_x1000.load(Ordering::Relaxed);
        let sr = out.sample_rate.load(Ordering::Relaxed);
        if bw > 0 && bh > 0 && fx > 0 {
            width = bw;
            height = bh;
            fps = fx as f64 / 1000.0;
            core_sample_rate = sr as f64;
            break;
        }
        // Check if child died early
        if let Ok(Some(status)) = child.try_wait() {
            let stderr_out = child
                .stderr
                .take()
                .and_then(|mut r| {
                    let mut s = String::new();
                    std::io::Read::read_to_string(&mut r, &mut s)
                        .ok()
                        .map(|_| s)
                })
                .unwrap_or_default();
            tracing::error!("[CORE] child exited early with {status}: {stderr_out}");
            unlink_shm(&out_name);
            unlink_shm(&in_name);
            return Err(format!("sc-core exited early with {status}: {stderr_out}"));
        }
        // Yield to the Tokio runtime rather than blocking a worker thread:
        // this wait can run up to ~18 s for late-geometry cores, and blocked
        // workers stall every other task on the runtime.
        tokio::time::sleep(Duration::from_millis(100)).await;
    }

    // Late-geometry cores (PPSSPP etc.) may deliver their first rendered
    // frame before they report base metadata via SET_GEOMETRY — accept frame
    // dimensions as readiness evidence so a healthy boot is never killed.
    if width == 0 {
        width = out.width.load(Ordering::Relaxed);
    }
    if height == 0 {
        height = out.height.load(Ordering::Relaxed);
    }
    if fps == 0.0 {
        fps = out.fps_x1000.load(Ordering::Relaxed) as f64 / 1000.0;
    }

    if width == 0 || fps == 0.0 {
        tracing::error!("[CORE] child didn't report metadata in time");
        let _ = child.kill();
        let _ = child.wait();
        unlink_shm(&out_name);
        unlink_shm(&in_name);
        return Err("sc-core did not report metadata before timeout".to_string());
    }

    tracing::info!("[CORE] child ready: {width}×{height} @ {fps:.1}fps");

    // ── Auto-load SRAM if a battery save exists ──────────────────────
    let rom_hash = saves::hash_rom(std::path::Path::new(&actual_rom_path));
    if let Some(ref hash) = rom_hash {
        // Pre-auth: core startup runs before the DC auth message resolves
        // the account, so SRAM auto-load uses the `shared` slot (#745).
        let sram_file = saves::sram_path("shared", hash);
        if sram_file.exists() {
            match std::fs::read(&sram_file) {
                Ok(data) if !data.is_empty() => {
                    let len = data.len().min(sc_core::MAX_RESPONSE);
                    unsafe {
                        std::ptr::copy_nonoverlapping(
                            data.as_ptr(),
                            out.response_data.as_ptr() as *mut u8,
                            len,
                        );
                    }
                    out.response_data_len.store(len as u32, Ordering::Relaxed);
                    inp.cmd_type.store(CMD_LOAD_SRAM, Ordering::Relaxed);
                    inp.cmd_ready.store(true, Ordering::Release);
                    // Wait briefly for core to process
                    std::thread::sleep(Duration::from_millis(50));
                    inp.cmd_ready.store(false, Ordering::Release);
                    tracing::info!(
                        "[SRAM] auto-loaded {} bytes from {}",
                        len,
                        sram_file.display()
                    );
                }
                Ok(_) => {}
                Err(e) => tracing::warn!("[SRAM] failed to read {}: {e}", sram_file.display()),
            }
        }
    }

    // Set up channels (same as before)
    let (frame_tx, frame_rx) = mpsc::sync_channel::<CoreFrame>(1);
    let (cmd_tx, cmd_rx) = mpsc::sync_channel::<CoreCommand>(16);
    let (response_tx, response_rx) = mpsc::sync_channel::<CoreResponse>(4);

    // Populate session metadata
    *session.core_width.lock().await = width;
    *session.core_height.lock().await = height;
    *session.core_fps.lock().await = fps;
    // Report the core's native sample rate — GStreamer's audioresample
    // handles any rate correctly. SameBoy reports ~2MHz; clamping it
    // causes resampler mismatch → static bursts.
    *session.core_sample_rate.lock().await = core_sample_rate;
    *session.core_frame_rx.lock().await = Some(frame_rx);
    *session.core_cmd_tx.lock().await = Some(cmd_tx);
    *session.core_response_rx.lock().await = Some(response_rx);
    session
        .core_started
        .store(true, std::sync::atomic::Ordering::Release);
    session
        .core_loaded
        .store(true, std::sync::atomic::Ordering::Relaxed);

    let cancel = session.cancel.clone();
    let core_stopped = session.core_stopped.clone();
    let shutdown_completion = CoreShutdownCompletion::registered(cancel.clone(), core_stopped);
    let out_name_clone = out_name.clone();
    let in_name_clone = in_name.clone();

    // Save state support — copy response data into CoreResponse
    let resp_tx = response_tx.clone();
    // Where the bridge records *why* the child died/stalled; `relay_core_died`
    // reads it back so the player gets a specific reason instead of the generic
    // "core process crashed". Moves into the bridge thread below.
    let reason_store = session.core_died_reason.clone();

    // ── Bridge thread: shm ↔ channels ───────────────────────────────
    let rom_hash_save = rom_hash.clone();
    std::thread::spawn(move || {
        let shutdown_completion = shutdown_completion;
        let _out_mmap = out_mmap; // keep mmap alive for lifetime of thread
        let _in_mmap = in_mmap; // keep mmap alive for lifetime of thread
        let mut frame_num: u64 = 0;
        let _frame_interval = Duration::from_secs_f64(1.0 / fps.max(1.0));

        let bridge_panicked = run_and_shutdown_after_panic(
            &mut child,
            |child| {
                // Watchdog clock: bumped on every delivered frame. If the child
                // stays alive but this ages past CORE_STALL_GRACE, we declare a
                // stall (missing video) instead of leaving the player frozen.
                let mut last_frame_at = std::time::Instant::now();
                loop {
                    // Check cancel
                    if cancel.is_cancelled() {
                        tracing::info!("[BRIDGE] cancel — capturing SRAM before child shutdown");
                        break;
                    }

                    // Write commands from channel → input shm
                    while let Ok(cmd) = cmd_rx.try_recv() {
                        match cmd {
                            CoreCommand::SetInput { port, state, ax, ay } => {
                                inp.port.store(port, Ordering::Relaxed);
                                inp.state.store(state, Ordering::Relaxed);
                                inp.ax.store(ax as i16, Ordering::Relaxed);
                                inp.ay.store(ay as i16, Ordering::Relaxed);
                                inp.cmd_type.store(CMD_SET_INPUT, Ordering::Relaxed);
                                inp.cmd_ready.store(true, Ordering::Release);
                            }
                            CoreCommand::SaveState => {
                                inp.cmd_type.store(CMD_SAVE_STATE, Ordering::Relaxed);
                                inp.cmd_ready.store(true, Ordering::Release);
                                std::thread::sleep(Duration::from_millis(100));
                                let ok = out.response_ok.load(Ordering::Relaxed);
                                let len = out.response_data_len.load(Ordering::Relaxed) as usize;
                                let data =
                                    out.response_data[..len.min(sc_core::MAX_RESPONSE)].to_vec();
                                let _ = resp_tx.send(CoreResponse::SaveStateResult { data, ok });
                            }
                            CoreCommand::LoadState { data } => {
                                let len = data.len().min(sc_core::MAX_RESPONSE);
                                unsafe {
                                    std::ptr::copy_nonoverlapping(
                                        data.as_ptr(),
                                        out.response_data.as_ptr() as *mut u8,
                                        len,
                                    );
                                }
                                out.response_data_len.store(len as u32, Ordering::Relaxed);
                                inp.cmd_type.store(CMD_LOAD_STATE, Ordering::Relaxed);
                                inp.cmd_ready.store(true, Ordering::Release);
                                std::thread::sleep(Duration::from_millis(100));
                                let ok = out.response_ok.load(Ordering::Relaxed);
                                let _ = resp_tx.send(CoreResponse::LoadStateResult { ok });
                            }
                        }
                    }

                    // Check child alive
                    match child.try_wait() {
                        Ok(Some(status)) => {
                            let stderr_out = child
                                .stderr
                                .take()
                                .and_then(|mut r| {
                                    let mut s = String::new();
                                    std::io::Read::read_to_string(&mut r, &mut s)
                                        .ok()
                                        .map(|_| s)
                                })
                                .unwrap_or_default();
                            tracing::warn!("[BRIDGE] child exited with {status}: {stderr_out}");
                            // Classify the real death (signal/code) so the
                            // player gets a specific reason instead of a generic
                            // "core process crashed".
                            *reason_store.lock().unwrap_or_else(|p| p.into_inner()) =
                                Some(classify_core_death(&status, &stderr_out));
                            // Deliver the crash sentinel *before* cancelling: a
                            // zero-width sentinel is the streaming loop's signal
                            // to relay core_died to the player, and it must not
                            // be dropped by a full channel nor bypassed by the
                            // cancellation branch winning the select first.
                            let _ = deliver_crash_sentinel(&frame_tx);
                            cancel.cancel();
                            break;
                        }
                        Ok(None) => {} // still running
                        Err(e) => {
                            tracing::error!("[BRIDGE] try_wait error: {e}");
                            *reason_store.lock().unwrap_or_else(|p| p.into_inner()) = Some(format!(
                                "Emulator process monitoring error (couldn't wait on it): {e}"
                            ));
                            let _ = deliver_crash_sentinel(&frame_tx);
                            cancel.cancel();
                            break;
                        }
                    }

                    // ── Stall watchdog ─────────────────────────────
                    // Child is alive but hasn't delivered a frame in a while.
                    // (If it actually died, the try_wait above already broke
                    // out.) Some broken core builds boot, spin, and never
                    // present video; surface that as a graceful core_died
                    // rather than leaving the player on a frozen/test-pattern
                    // stream with no explanation.
                    if last_frame_at.elapsed() > CORE_STALL_GRACE {
                        tracing::error!(
                            "[BRIDGE] core stalled — no video frame for {:?}",
                            last_frame_at.elapsed()
                        );
                        *reason_store.lock().unwrap_or_else(|p| p.into_inner()) = Some(
                            "Emulator is not responding (no video frames)".to_string(),
                        );
                        let _ = deliver_crash_sentinel(&frame_tx);
                        cancel.cancel();
                        break;
                    }

                    // Read frame from output shm
                    if out.frame_ready.load(Ordering::Acquire) {
                        let fw = out.width.load(Ordering::Relaxed);
                        let fh = out.height.load(Ordering::Relaxed);
                        let audio_len = out.audio_len.load(Ordering::Relaxed) as usize;

                        let px_count = (fw as usize * fh as usize * 3).min(sc_core::MAX_PIXELS);
                        let mut pixels = vec![0u8; px_count];
                        unsafe {
                            std::ptr::copy_nonoverlapping(
                                out.pixels.as_ptr(),
                                pixels.as_mut_ptr(),
                                px_count,
                            );
                        }

                        let audio_count = audio_len.min(sc_core::MAX_AUDIO);
                        let mut audio = vec![0i16; audio_count];
                        unsafe {
                            std::ptr::copy_nonoverlapping(
                                out.audio.as_ptr(),
                                audio.as_mut_ptr(),
                                audio_count,
                            );
                        }

                        out.frame_ready.store(false, Ordering::Release);

                        if !deliver_latest_frame(
                            &frame_tx,
                            CoreFrame {
                                pixels,
                                width: fw,
                                height: fh,
                                audio,
                            },
                        ) {
                            break;
                        }
                        frame_num = frame_num.wrapping_add(1);
                        // A frame was produced — keep the stall watchdog from
                        // firing on a healthy core.
                        last_frame_at = std::time::Instant::now();
                    }

                    std::thread::sleep(Duration::from_millis(1));
                }
            },
            |child| {
                // ── Auto-save SRAM, then terminate child ────────────
                capture_sram_and_terminate(
                    child,
                    inp,
                    out,
                    rom_hash_save.as_deref(),
                    Duration::from_millis(500),
                    |hash, data| {
                        // Teardown also runs pre/post-auth without account
                        // resolution context — `shared` slot keeps it working
                        // (#745).
                        let sram_file = saves::sram_path("shared", hash);
                        match saves::write_atomic(&sram_file, data) {
                            Ok(()) => {
                                tracing::info!(
                                    "[SRAM] auto-saved {} bytes to {}",
                                    data.len(),
                                    sram_file.display()
                                )
                            }
                            Err(e) => {
                                tracing::error!("[SRAM] write failed {}: {e}", sram_file.display())
                            }
                        }
                    },
                );
            },
        );

        if bridge_panicked {
            tracing::error!("[BRIDGE] processing loop panicked; shutdown lifecycle completed");
        }

        // Cleanup shared-memory files after child termination.
        unlink_shm(&out_name_clone);
        unlink_shm(&in_name_clone);
        tracing::info!("[BRIDGE] exited ({} frames)", frame_num);
        shutdown_completion.complete();
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn production_bridge_keeps_registration_and_explicit_completion_wired() {
        let source = include_str!("core_bridge.rs");
        let registration = [
            "CoreShutdownCompletion::",
            "registered(cancel.clone(), core_stopped)",
        ]
        .concat();
        let completion = ["shutdown_completion", ".complete()"].concat();
        assert_eq!(source.matches(&registration).count(), 1);
        assert_eq!(source.matches(&completion).count(), 1);
    }

    #[tokio::test]
    async fn incomplete_panic_does_not_report_core_shutdown_complete() {
        let registry = CoreBridgeShutdownRegistry::default();
        let cancel = tokio_util::sync::CancellationToken::new();
        let stopped = tokio_util::sync::CancellationToken::new();
        let observed_stopped = stopped.clone();

        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _completion = CoreShutdownCompletion::registered_in(&registry, cancel, stopped);
            panic!("induced bridge panic before shutdown lifecycle");
        }));

        assert!(result.is_err());
        assert!(
            !observed_stopped.is_cancelled(),
            "panic unwinding must not falsely report completed shutdown"
        );
    }

    #[test]
    fn full_frame_channel_never_blocks_bridge_progress() {
        let (tx, rx) = mpsc::sync_channel::<CoreFrame>(1);
        tx.send(CoreFrame {
            pixels: vec![1],
            width: 1,
            height: 1,
            audio: vec![],
        })
        .unwrap();

        let (finished_tx, finished_rx) = mpsc::channel();
        std::thread::spawn(move || {
            let connected = deliver_latest_frame(
                &tx,
                CoreFrame {
                    pixels: vec![2],
                    width: 1,
                    height: 1,
                    audio: vec![],
                },
            );
            finished_tx.send(connected).unwrap();
        });

        assert_eq!(
            finished_rx.recv_timeout(Duration::from_millis(100)),
            Ok(true),
            "a full frame channel must drop a stale frame instead of blocking cancellation"
        );
        assert_eq!(rx.recv().unwrap().pixels, vec![1]);
    }

    #[test]
    fn crash_sentinel_is_not_dropped_by_a_full_frame_channel() {
        // A core-crash sentinel must survive a full single-slot channel: the
        // streaming loop depends on the width-0 sentinel to relay core_died to
        // the player. Unlike deliver_latest_frame, which drops stale frames,
        // deliver_crash_sentinel retries until the consumer drains, so the
        // crash is never lost.
        let (tx, rx) = mpsc::sync_channel::<CoreFrame>(1);
        tx.send(CoreFrame {
            pixels: vec![9],
            width: 640,
            height: 480,
            audio: vec![],
        })
        .unwrap();

        // The "consumer" drains the fill frame shortly after send so the
        // retry loop can land the sentinel. Keep rx alive (shared, not owned by
        // the drainer) so the channel isn't disconnected while we call
        // deliver_crash_sentinel — a dropped receiver means "consumer gone".
        let rx_shared = std::sync::Arc::new(std::sync::Mutex::new(rx));
        let rx_clone = std::sync::Arc::clone(&rx_shared);
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(20));
            let _ = rx_clone.lock().unwrap().try_recv();
        });

        // Must return true (sentinel enqueued) despite the full channel.
        assert!(deliver_crash_sentinel(&tx));
    }

    #[test]
    fn crash_sentinel_drains_past_a_normal_frame_and_lands() {
        let (tx, rx) = mpsc::sync_channel::<CoreFrame>(1);
        tx.send(CoreFrame {
            pixels: vec![1],
            width: 640,
            height: 480,
            audio: vec![],
        })
        .unwrap();

        // Drain the normal frame, then enqueue the sentinel.
        let _ = rx.recv();
        assert!(deliver_crash_sentinel(&tx));
        let sentinel = rx.recv().unwrap();
        assert_eq!(sentinel.width, 0);
        assert!(sentinel.pixels.is_empty());
    }

    #[tokio::test]
    async fn replacement_waits_for_core_shutdown_completion() {
        let cancel = tokio_util::sync::CancellationToken::new();
        let stopped = tokio_util::sync::CancellationToken::new();
        let worker_cancel = cancel.clone();
        let worker_stopped = stopped.clone();

        tokio::spawn(async move {
            worker_cancel.cancelled().await;
            tokio::time::sleep(Duration::from_millis(25)).await;
            worker_stopped.cancel();
        });

        let started = std::time::Instant::now();
        assert!(cancel_and_wait_for_core(&cancel, &stopped, Duration::from_millis(250),).await);
        assert!(started.elapsed() >= Duration::from_millis(25));
    }

    #[test]
    fn game_replacement_uses_core_shutdown_barrier() {
        let source = include_str!("commands/game.rs");
        assert!(source.contains("cancel_and_wait_for_core"));
        assert!(source.matches("cleanup_failed_start(").count() >= 5);
        assert!(source.matches("old_pc.close().await").count() >= 4);
        assert!(source.contains("sessions.get(game_id).cloned()"));
        assert!(source.contains("stream_cancel.cancel()"));

        let command_loop = include_str!("commands/mod.rs");
        assert!(command_loop.contains("s.cancel.is_cancelled() && s.core_stopped.is_cancelled()"));
    }

    #[tokio::test]
    async fn shutdown_registry_retains_bridge_after_session_handles_are_dropped() {
        let registry = CoreBridgeShutdownRegistry::default();
        let cancel = tokio_util::sync::CancellationToken::new();
        let stopped = tokio_util::sync::CancellationToken::new();
        let worker_cancel = cancel.clone();
        let completion = CoreShutdownCompletion::registered_in(&registry, cancel, stopped);

        tokio::spawn(async move {
            worker_cancel.cancelled().await;
            tokio::time::sleep(Duration::from_millis(25)).await;
            completion.complete();
        });

        let started = std::time::Instant::now();
        assert!(registry.cancel_and_wait(Duration::from_millis(250)).await);
        assert!(started.elapsed() >= Duration::from_millis(25));
    }

    #[tokio::test]
    async fn shutdown_registry_uses_one_deadline_for_multiple_bridges() {
        let registry = CoreBridgeShutdownRegistry::default();
        for _ in 0..3 {
            registry.register(
                tokio_util::sync::CancellationToken::new(),
                tokio_util::sync::CancellationToken::new(),
            );
        }

        let started = std::time::Instant::now();
        assert!(!registry.cancel_and_wait(Duration::from_millis(30)).await);
        assert!(started.elapsed() < Duration::from_millis(100));
    }

    struct SharedMemoryCleanup {
        input_name: String,
        output_name: String,
    }

    impl Drop for SharedMemoryCleanup {
        fn drop(&mut self) {
            unlink_shm(&self.input_name);
            unlink_shm(&self.output_name);
        }
    }

    struct FakeChild {
        alive: Arc<std::sync::atomic::AtomicBool>,
        terminated: Arc<std::sync::atomic::AtomicBool>,
    }

    impl CoreChildLifecycle for FakeChild {
        fn is_alive(&mut self) -> bool {
            self.alive.load(Ordering::Acquire)
        }

        fn terminate(&mut self) {
            self.terminated.store(true, Ordering::Release);
            self.alive.store(false, Ordering::Release);
        }
    }

    #[test]
    fn bridge_panic_still_persists_fresh_sram_before_terminating_child() {
        let suffix = format!("{:032x}", rand::random::<u128>());
        let input_name = format!("sc-test-in-{suffix}");
        let output_name = format!("sc-test-out-{suffix}");
        let _cleanup = SharedMemoryCleanup {
            input_name: input_name.clone(),
            output_name: output_name.clone(),
        };
        let mut input_map = map_shm::<InputShm>(&input_name, InputShm::size()).unwrap();
        let mut output_map = map_shm::<OutputShm>(&output_name, OutputShm::size()).unwrap();
        // SAFETY: mappings are zeroed, correctly sized/aligned, and remain
        // alive for every shared-memory access in this test.
        let input = unsafe { &*(input_map.as_mut_ptr() as *const InputShm) };
        let output = unsafe { &*(output_map.as_mut_ptr() as *const OutputShm) };

        output.response_ok.store(true, Ordering::Relaxed);
        output.response_data_len.store(4, Ordering::Relaxed);
        let alive = Arc::new(std::sync::atomic::AtomicBool::new(true));
        let terminated = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let mut child = FakeChild {
            alive: alive.clone(),
            terminated: terminated.clone(),
        };
        let mut persisted = None;

        std::thread::scope(|scope| {
            let terminated_at_ack = terminated.clone();
            scope.spawn(move || {
                while !input.cmd_ready.load(Ordering::Acquire) {
                    std::thread::yield_now();
                }
                assert!(
                    !terminated_at_ack.load(Ordering::Acquire),
                    "child terminated before SRAM acknowledgement"
                );
                let fresh = [4_u8, 5, 6];
                // SAFETY: `fresh` fits in the mapped response buffer.
                unsafe {
                    std::ptr::copy_nonoverlapping(
                        fresh.as_ptr(),
                        output.response_data.as_ptr() as *mut u8,
                        fresh.len(),
                    );
                }
                output
                    .response_data_len
                    .store(fresh.len() as u32, Ordering::Relaxed);
                output.response_ok.store(true, Ordering::Relaxed);
                input.cmd_ready.store(false, Ordering::Release);
            });

            let panicked = run_and_shutdown_after_panic(
                &mut child,
                |_| panic!("induced bridge-loop panic"),
                |child| {
                    capture_sram_and_terminate(
                        child,
                        input,
                        output,
                        Some("test-rom"),
                        Duration::from_millis(250),
                        |_, data| {
                            assert!(
                                !terminated.load(Ordering::Acquire),
                                "child terminated before SRAM persistence"
                            );
                            persisted = Some(data.to_vec());
                        },
                    );
                },
            );
            assert!(panicked);
        });

        assert_eq!(persisted, Some(vec![4, 5, 6]));
        assert!(child.terminated.load(Ordering::Acquire));
        assert!(!child.alive.load(Ordering::Acquire));
    }

    #[test]
    fn sram_snapshot_waits_for_fresh_ack_and_rejects_stale_response() {
        let suffix = format!("{:032x}", rand::random::<u128>());
        let input_name = format!("sc-test-in-{suffix}");
        let output_name = format!("sc-test-out-{suffix}");
        let _cleanup = SharedMemoryCleanup {
            input_name: input_name.clone(),
            output_name: output_name.clone(),
        };
        let mut input_map = map_shm::<InputShm>(&input_name, InputShm::size()).unwrap();
        let mut output_map = map_shm::<OutputShm>(&output_name, OutputShm::size()).unwrap();
        // SAFETY: each shared-memory mapping is zeroed, correctly sized,
        // suitably aligned for its type, and remains alive for the test.
        let input = unsafe { &*(input_map.as_mut_ptr() as *const InputShm) };
        let output = unsafe { &*(output_map.as_mut_ptr() as *const OutputShm) };

        output.response_ok.store(true, Ordering::Relaxed);
        output.response_data_len.store(4, Ordering::Relaxed);
        let stale = [9_u8, 9, 9, 9];
        // SAFETY: `stale` fits in the mapped response buffer.
        unsafe {
            std::ptr::copy_nonoverlapping(
                stale.as_ptr(),
                output.response_data.as_ptr() as *mut u8,
                stale.len(),
            );
        }

        let snapshot = std::thread::scope(|scope| {
            scope.spawn(|| {
                while !input.cmd_ready.load(Ordering::Acquire) {
                    std::thread::yield_now();
                }
                assert_eq!(input.cmd_type.load(Ordering::Relaxed), CMD_SAVE_SRAM);
                assert!(!output.response_ok.load(Ordering::Relaxed));
                assert_eq!(output.response_data_len.load(Ordering::Relaxed), 0);

                let fresh = [1_u8, 2, 3];
                // SAFETY: `fresh` fits in the mapped response buffer.
                unsafe {
                    std::ptr::copy_nonoverlapping(
                        fresh.as_ptr(),
                        output.response_data.as_ptr() as *mut u8,
                        fresh.len(),
                    );
                }
                output
                    .response_data_len
                    .store(fresh.len() as u32, Ordering::Relaxed);
                output.response_ok.store(true, Ordering::Relaxed);
                input.cmd_ready.store(false, Ordering::Release);
            });

            request_sram_snapshot(input, output, || true, Duration::from_millis(250))
        });

        assert_eq!(snapshot, Some(vec![1, 2, 3]));
    }

    #[test]
    fn sram_snapshot_rejects_stale_response_when_child_is_dead() {
        let suffix = format!("{:032x}", rand::random::<u128>());
        let input_name = format!("sc-test-in-{suffix}");
        let output_name = format!("sc-test-out-{suffix}");
        let _cleanup = SharedMemoryCleanup {
            input_name: input_name.clone(),
            output_name: output_name.clone(),
        };
        let mut input_map = map_shm::<InputShm>(&input_name, InputShm::size()).unwrap();
        let mut output_map = map_shm::<OutputShm>(&output_name, OutputShm::size()).unwrap();
        // SAFETY: mappings are zeroed, correctly sized/aligned, and live long
        // enough for every shared-memory access in this test.
        let input = unsafe { &*(input_map.as_mut_ptr() as *const InputShm) };
        let output = unsafe { &*(output_map.as_mut_ptr() as *const OutputShm) };
        output.response_ok.store(true, Ordering::Relaxed);
        output.response_data_len.store(4, Ordering::Relaxed);

        let snapshot = request_sram_snapshot(input, output, || false, Duration::from_millis(250));

        assert_eq!(snapshot, None);
    }

    #[tokio::test]
    async fn core_startup_failure_is_reported_to_caller() {
        let stack = crate::webrtc::build_session_pc_lan().await.unwrap();
        let session = Arc::new(GameSession {
            game_id: format!("{:032x}", rand::random::<u128>()),
            cloud_session_id: None,
            cancel: tokio_util::sync::CancellationToken::new(),
            core_stopped: tokio_util::sync::CancellationToken::new(),
            core_died_reason: std::sync::Arc::new(std::sync::Mutex::new(None)),
            pc: std::sync::Mutex::new(stack.pc),
            video_track: std::sync::Mutex::new(stack.video_track),
            audio_track: std::sync::Mutex::new(stack.audio_track),
            dc: tokio::sync::Mutex::new(None),
            host_lifecycle: tokio::sync::Mutex::new(()),
            guests: tokio::sync::Mutex::new(Vec::new()),
            guest_lifecycle: tokio::sync::Mutex::new(()),
            pending_guest_exchanges: std::sync::Arc::new(std::sync::atomic::AtomicU32::new(0)),
            pending_guest_tokens: std::sync::Arc::new(std::sync::Mutex::new(
                std::collections::HashSet::new(),
            )),
            host_connected: std::sync::atomic::AtomicBool::new(false),
            local_players: std::sync::atomic::AtomicU32::new(1),
            claimed_peer: tokio::sync::Mutex::new(None),
            resident: std::sync::atomic::AtomicBool::new(false),
            account_id: tokio::sync::Mutex::new(None),
            core_started: std::sync::atomic::AtomicBool::new(false),
            core_loaded: std::sync::atomic::AtomicBool::new(false),
            core_loading: std::sync::atomic::AtomicBool::new(false),
            core_cmd_tx: tokio::sync::Mutex::new(None),
            core_frame_rx: tokio::sync::Mutex::new(None),
            core_response_rx: tokio::sync::Mutex::new(None),
            video_enc: tokio::sync::Mutex::new(None),
            audio_enc: tokio::sync::Mutex::new(None),
            rom_hash: tokio::sync::Mutex::new(None),
            core_width: tokio::sync::Mutex::new(0),
            core_height: tokio::sync::Mutex::new(0),
            core_fps: tokio::sync::Mutex::new(0.0),
            core_sample_rate: tokio::sync::Mutex::new(48_000.0),
        });

        let result = load_core_into_session(
            &session,
            Some(std::path::Path::new("/definitely/missing/core.so")),
            Some("/definitely/missing/game.rom"),
            Some("test"),
        )
        .await;

        assert!(result.is_err());
        assert!(!session.core_loaded.load(Ordering::Relaxed));
    }
}
