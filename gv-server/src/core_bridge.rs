//! Bridge between the libretro core (child process) and the tokio streaming loop.
//!
//! The core runs in a separate process (gv-core) for crash isolation.
//! If Nestopia segfaults, only the child dies — gv-server survives.
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
use std::sync::Arc;
use std::time::Duration;

use gv_core::{OutputShm, InputShm, map_shm, unlink_shm, CMD_SET_INPUT, CMD_SAVE_STATE, CMD_LOAD_STATE, CMD_SAVE_SRAM, CMD_LOAD_SRAM};

use crate::session::GameSession;

use crate::saves;

// ── Core download (unchanged) ──────────────────────────────────────

fn resolve_core_path(core_filename: &str) -> PathBuf {
    let cores_dir = std::env::var("GV_CORES_DIR").unwrap_or_else(|_| {
        let mut p = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        p.pop();
        p.push("test-data/cores");
        if p.exists() {
            return p.to_string_lossy().to_string();
        }
        p.pop();
        p.pop();
        p.push("cores");
        p.to_string_lossy().to_string()
    });
    PathBuf::from(&cores_dir).join(core_filename)
}

static BUILDBOT_BASE: std::sync::LazyLock<String> = std::sync::LazyLock::new(|| {
    std::env::var("GV_BUILDBOT_URL")
        .unwrap_or_else(|_| "https://buildbot.libretro.com/nightly/linux/x86_64/latest".into())
});

static DOWNLOADING: std::sync::LazyLock<std::sync::Mutex<std::collections::HashSet<String>>> =
    std::sync::LazyLock::new(|| std::sync::Mutex::new(std::collections::HashSet::new()));

pub async fn ensure_core(core_filename: &str, client: &reqwest::Client) -> Result<PathBuf, String> {
    let core_path = resolve_core_path(core_filename);
    if core_path.exists() { return Ok(core_path); }

    let already_downloading = {
        let mut inflight = DOWNLOADING.lock().map_err(|e| format!("lock poisoned: {e}"))?;
        if inflight.contains(core_filename) { true }
        else { inflight.insert(core_filename.to_string()); false }
    };

    if already_downloading {
        for _ in 0..60 {
            tokio::time::sleep(std::time::Duration::from_secs(1)).await;
            if core_path.exists() { return Ok(core_path); }
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
    core_filename: &str, core_path: &PathBuf, client: &reqwest::Client,
) -> Result<(), String> {
    let zip_name = format!("{core_filename}.zip");
    let url = format!("{}/{}", *BUILDBOT_BASE, zip_name);
    tracing::info!("[CORE] downloading {url}");

    let resp = client.get(&url).send().await.map_err(|e| format!("download {url}: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("download {url}: HTTP {}", resp.status()));
    }

    let bytes = resp.bytes().await.map_err(|e| format!("read body: {e}"))?;
    let cursor = std::io::Cursor::new(bytes.as_ref());
    let mut archive = zip::ZipArchive::new(cursor).map_err(|e| format!("open zip: {e}"))?;

    if archive.len() != 1 {
        return Err(format!("expected 1 file in {zip_name}, got {}", archive.len()));
    }

    let mut entry = archive.by_index(0).map_err(|e| format!("read zip entry: {e}"))?;
    let name = entry.name().to_string();
    if !name.ends_with(".so") || name.contains('/') {
        return Err(format!("unexpected file in {zip_name}: {name} (expected {core_filename})"));
    }

    if let Some(parent) = core_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("create cores dir: {e}"))?;
    }

    let tmp_path = core_path.with_extension("tmp");
    let mut out = std::fs::File::create(&tmp_path).map_err(|e| format!("create {tmp_path:?}: {e}"))?;
    std::io::copy(&mut entry, &mut out).map_err(|e| format!("extract {name}: {e}"))?;
    drop(out);

    #[cfg(unix)] {
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
    #[allow(dead_code)] pub width: u32,
    #[allow(dead_code)] pub height: u32,
    pub audio: Vec<i16>,
}

pub enum CoreCommand {
    SetInput { port: u32, state: u16 },
    SaveState,
    LoadState { data: Vec<u8> },
}

pub enum CoreResponse {
    SaveStateResult { data: Vec<u8>, ok: bool },
    LoadStateResult { ok: bool },
}

// ── gv-core binary location ────────────────────────────────────────

fn find_gv_core_binary() -> PathBuf {
    // Check env var first
    if let Ok(p) = std::env::var("GV_CORE_BIN") {
        let path = PathBuf::from(&p);
        if path.exists() { return path; }
    }
    // Check next to gv-server binary
    if let Ok(exe) = std::env::current_exe() {
        let sibling = exe.with_file_name("gv-core");
        if sibling.exists() { return sibling; }
    }
    // Check debug/release target dirs (cargo workspace root)
    let mut target = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    target.pop(); // gv-server → workspace root
    for profile in &["release", "debug"] {
        let p = target.join("target").join(profile).join("gv-core");
        if p.exists() { return p; }
    }
    // Fallback
    PathBuf::from("gv-core")
}

// ── Child process management ───────────────────────────────────────

/// Load a libretro core by spawning gv-core child process.
/// Keeps the same interface as the old in-process load — channels are
/// populated the same way. Streaming loop + command handling unchanged.
pub async fn load_core_into_session(
    session: &Arc<GameSession>,
    core_path: Option<&std::path::Path>,
    content_path: Option<&str>,
    _platform: Option<&str>,
) {
    let game_id = &session.game_id;

    let core_path_str = match core_path {
        Some(p) => p.to_string_lossy().to_string(),
        None => {
            std::env::var("GV_CORE_PATH").unwrap_or_else(|_| {
                let mut p = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"));
                p.pop(); p.push("test-data/cores/2048_libretro.so");
                p.to_string_lossy().to_string()
            })
        }
    };

    let rom_path = content_path.unwrap_or("");
    let out_name = format!("gv-out-{game_id}");
    let in_name = format!("gv-in-{game_id}");

    // Create shm
    let out_mmap = match map_shm::<OutputShm>(&out_name, OutputShm::size()) {
        Ok(m) => m,
        Err(e) => { tracing::error!("[CORE] out shm: {e}"); return; }
    };
    let in_mmap = match map_shm::<InputShm>(&in_name, InputShm::size()) {
        Ok(m) => m,
        Err(e) => { tracing::error!("[CORE] in shm: {e}"); return; }
    };

    let out: &OutputShm = unsafe { &*(out_mmap.as_ptr() as *const OutputShm) };
    let inp: &InputShm = unsafe { &*(in_mmap.as_ptr() as *const InputShm) };

    // Find gv-core binary
    let core_bin = find_gv_core_binary();
    tracing::info!("[CORE] spawning {} {} {} {}", core_bin.display(), core_path_str, rom_path, game_id);

    let mut child = match std::process::Command::new(&core_bin)
        .args([&core_path_str, rom_path, &out_name, &in_name])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .spawn()
    {
        Ok(c) => c,
        Err(e) => {
            tracing::error!("[CORE] spawn gv-core: {e}");
            unlink_shm(&out_name);
            unlink_shm(&in_name);
            return;
        }
    };

    // Wait for metadata (core reports dimensions before frame loop)
    let mut width: u32 = 0;
    let mut height: u32 = 0;
    let mut fps: f64 = 0.0;
    for _ in 0..50 { // 5 second timeout
        let bw = out.base_width.load(Ordering::Relaxed);
        let bh = out.base_height.load(Ordering::Relaxed);
        let fx = out.fps_x1000.load(Ordering::Relaxed);
        if bw > 0 && bh > 0 && fx > 0 {
            width = bw;
            height = bh;
            fps = fx as f64 / 1000.0;
            break;
        }
        // Check if child died early
        if let Ok(Some(status)) = child.try_wait() {
            let stderr_out = child.stderr.take()
                .and_then(|mut r| {
                    let mut s = String::new();
                    std::io::Read::read_to_string(&mut r, &mut s).ok().map(|_| s)
                })
                .unwrap_or_default();
            tracing::error!("[CORE] child exited early with {status}: {stderr_out}");
            unlink_shm(&out_name);
            unlink_shm(&in_name);
            return;
        }
        std::thread::sleep(Duration::from_millis(100));
    }

    if width == 0 || fps == 0.0 {
        tracing::error!("[CORE] child didn't report metadata in time");
        let _ = child.kill();
        unlink_shm(&out_name);
        unlink_shm(&in_name);
        return;
    }

    tracing::info!("[CORE] child ready: {width}×{height} @ {fps:.1}fps");

    // ── Auto-load SRAM if a battery save exists ──────────────────────
    let rom_hash = saves::hash_rom(std::path::Path::new(rom_path));
    if let Some(ref hash) = rom_hash {
        let sram_file = saves::sram_path(hash);
        if sram_file.exists() {
            match std::fs::read(&sram_file) {
                Ok(data) if !data.is_empty() => {
                    let len = data.len().min(gv_core::MAX_RESPONSE);
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
                    tracing::info!("[SRAM] auto-loaded {} bytes from {}", len, sram_file.display());
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
    *session.core_frame_rx.lock().await = Some(frame_rx);
    *session.core_cmd_tx.lock().await = Some(cmd_tx);
    *session.core_response_rx.lock().await = Some(response_rx);
    session.core_loaded.store(true, std::sync::atomic::Ordering::Relaxed);
    session.core_loading.store(false, std::sync::atomic::Ordering::Relaxed);

    let cancel = session.cancel.clone();
    let out_name_clone = out_name.clone();
    let in_name_clone = in_name.clone();

    // Save state support — copy response data into CoreResponse
    let resp_tx = response_tx.clone();

    // ── Bridge thread: shm ↔ channels ───────────────────────────────
    let rom_hash_save = rom_hash.clone();
    std::thread::spawn(move || {
        let _out_mmap = out_mmap; // keep mmap alive for lifetime of thread
        let _in_mmap = in_mmap;   // keep mmap alive for lifetime of thread
        let mut frame_num: u64 = 0;
        let frame_interval = Duration::from_secs_f64(1.0 / fps.max(1.0));

        loop {
            // Check cancel
            if cancel.is_cancelled() {
                tracing::info!("[BRIDGE] cancel — killing child");
                let _ = child.kill();
                let _ = child.wait();
                break;
            }

            // Write commands from channel → input shm
            while let Ok(cmd) = cmd_rx.try_recv() {
                match cmd {
                    CoreCommand::SetInput { port, state } => {
                        inp.port.store(port, Ordering::Relaxed);
                        inp.state.store(state, Ordering::Relaxed);
                        inp.cmd_type.store(CMD_SET_INPUT, Ordering::Relaxed);
                        inp.cmd_ready.store(true, Ordering::Release);
                    }
                    CoreCommand::SaveState => {
                        inp.cmd_type.store(CMD_SAVE_STATE, Ordering::Relaxed);
                        inp.cmd_ready.store(true, Ordering::Release);
                        std::thread::sleep(Duration::from_millis(100));
                        let ok = out.response_ok.load(Ordering::Relaxed);
                        let len = out.response_data_len.load(Ordering::Relaxed) as usize;
                        let data = out.response_data[..len.min(gv_core::MAX_RESPONSE)].to_vec();
                        let _ = resp_tx.send(CoreResponse::SaveStateResult { data, ok });
                    }
                    CoreCommand::LoadState { data } => {
                        let len = data.len().min(gv_core::MAX_RESPONSE);
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
                    let stderr_out = child.stderr.take()
                        .and_then(|mut r| {
                            let mut s = String::new();
                            std::io::Read::read_to_string(&mut r, &mut s).ok().map(|_| s)
                        })
                        .unwrap_or_default();
                    tracing::warn!("[BRIDGE] child exited with {status}: {stderr_out}");
                    let _ = frame_tx.send(CoreFrame { pixels: vec![], width: 0, height: 0, audio: vec![] });
                    break;
                }
                Ok(None) => {} // still running
                Err(e) => {
                    tracing::error!("[BRIDGE] try_wait error: {e}");
                    let _ = frame_tx.send(CoreFrame { pixels: vec![], width: 0, height: 0, audio: vec![] });
                    break;
                }
            }

            // Read frame from output shm
            if out.frame_ready.load(Ordering::Acquire) {
                let fw = out.width.load(Ordering::Relaxed);
                let fh = out.height.load(Ordering::Relaxed);
                let audio_len = out.audio_len.load(Ordering::Relaxed) as usize;

                let px_count = (fw as usize * fh as usize * 3).min(gv_core::MAX_PIXELS);
                let mut pixels = vec![0u8; px_count];
                unsafe {
                    std::ptr::copy_nonoverlapping(out.pixels.as_ptr(), pixels.as_mut_ptr(), px_count);
                }

                let audio_count = audio_len.min(gv_core::MAX_AUDIO);
                let mut audio = vec![0i16; audio_count];
                unsafe {
                    std::ptr::copy_nonoverlapping(out.audio.as_ptr(), audio.as_mut_ptr(), audio_count);
                }

                out.frame_ready.store(false, Ordering::Release);

                if frame_tx.send(CoreFrame { pixels, width: fw, height: fh, audio }).is_err() {
                    break;
                }
                frame_num = frame_num.wrapping_add(1);
            }

            std::thread::sleep(Duration::from_millis(1));
        }

        // ── Auto-save SRAM on shutdown ──────────────────────────────
        if let Some(ref hash) = rom_hash_save {
            // Signal gv-core to save SRAM (may fail if core already died)
            inp.cmd_type.store(CMD_SAVE_SRAM, Ordering::Relaxed);
            inp.cmd_ready.store(true, Ordering::Release);
            std::thread::sleep(Duration::from_millis(100));
            let ok = out.response_ok.load(Ordering::Relaxed);
            let len = out.response_data_len.load(Ordering::Relaxed) as usize;
            if ok && len > 0 {
                let data = &out.response_data[..len.min(gv_core::MAX_RESPONSE)];
                let sram_file = saves::sram_path(hash);
                match saves::write_atomic(&sram_file, data) {
                    Ok(()) => tracing::info!("[SRAM] auto-saved {} bytes to {}", len, sram_file.display()),
                    Err(e) => tracing::error!("[SRAM] write failed {}: {e}", sram_file.display()),
                }
            }
        }

        // Cleanup
        let _ = child.kill();
        let _ = child.wait();
        unlink_shm(&out_name_clone);
        unlink_shm(&in_name_clone);
        tracing::info!("[BRIDGE] exited ({} frames)", frame_num);
    });
}
