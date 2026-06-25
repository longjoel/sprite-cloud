//! Bridge between the libretro core (OS thread) and the tokio streaming loop.
//!
//! The core must run on a dedicated OS thread because libretro callbacks
//! use thread-local storage. Frames are sent via a bounded sync channel
//! to the tokio task that encodes and streams them. Input commands flow
//! in the opposite direction via a separate channel.
//!
//! SRAM lifecycle:
//! - On load: hash ROM, derive save dir, restore battery.srm if present
//! - On exit: save SRAM atomically before core unload

use std::path::PathBuf;
use std::sync::mpsc::{self, Receiver, SyncSender};
use std::time::Duration;

use libretro_runner::{Core, CoreConfig, JoypadButton};

use crate::saves;

// ── Core download (from deleted worker/core.rs) ──────────────────────

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

/// A frame produced by the core: RGB24 pixels + dimensions.
#[derive(Clone)]
pub struct CoreFrame {
    pub pixels: Vec<u8>,
    #[allow(dead_code)]
    pub width: u32,
    #[allow(dead_code)]
    pub height: u32,
    /// Interleaved stereo i16 PCM audio samples for this frame.
    pub audio: Vec<i16>,
}

/// Commands sent from the streaming task to the core thread.
pub enum CoreCommand {
    SetJoypad { port: u32, button: JoypadButton, pressed: bool },
    /// Set the full 16-bit joypad state for a port (RetroArch binary format).
    SetInput { port: u32, state: u16 },
    SaveState { slot: u8 },
    LoadState { slot: u8 },
    Reset,
    DiskEject,
    DiskInsert { index: u32 },
}

/// Responses sent from the core thread back to the streaming task.
pub enum CoreResponse {
    SaveStateResult { slot: u8, data: Vec<u8>, ok: bool },
    LoadStateResult { slot: u8, ok: bool },
}

/// Handle a save state command on the core thread.
fn handle_save_state(
    core: &Core,
    slot: u8,
    rom_hash: Option<&str>,
    response_tx: &SyncSender<CoreResponse>,
) {
    let data = core.save_state();
    let ok = data.is_some();

    if let (Some(data), Some(hash)) = (&data, rom_hash) {
        let path = saves::state_path(hash, slot);
        if let Err(e) = saves::write_atomic(&path, data) {
            tracing::error!(
                "[CORE] Failed to save state slot {} to {}: {}",
                slot,
                path.display(),
                e
            );
        } else {
            tracing::info!(
                "[CORE] Saved state slot {} to {} ({} bytes)",
                slot,
                path.display(),
                data.len()
            );
        }
    }

    let _ = response_tx.send(CoreResponse::SaveStateResult {
        slot,
        data: data.unwrap_or_default(),
        ok,
    });
}

/// Handle a load state command on the core thread.
fn handle_load_state(
    core: &mut Core,
    slot: u8,
    rom_hash: Option<&str>,
    response_tx: &SyncSender<CoreResponse>,
) {
    let ok = match rom_hash {
        Some(hash) => {
            let path = saves::state_path(hash, slot);
            match std::fs::read(&path) {
                Ok(data) => {
                    let success = core.load_state(&data);
                    if success {
                        tracing::info!(
                            "[CORE] Loaded state slot {} from {} ({} bytes)",
                            slot,
                            path.display(),
                            data.len()
                        );
                    } else {
                        tracing::warn!(
                            "[CORE] Failed to unserialize state slot {} from {}",
                            slot,
                            path.display()
                        );
                    }
                    success
                }
                Err(e) => {
                    tracing::warn!(
                        "[CORE] No save state at slot {} ({}): {}",
                        slot,
                        path.display(),
                        e
                    );
                    false
                }
            }
        }
        None => false,
    };

    let _ = response_tx.send(CoreResponse::LoadStateResult { slot, ok });
}

// ── Session-aware core loading (for in-process use) ────────────────

use crate::session::GameSession;
use std::sync::Arc;

/// Load a libretro core into an existing GameSession.
/// Takes explicit paths instead of reading env vars.
/// Spawns the core on a dedicated OS thread and populates
/// the session's channels, dimensions, and metadata.
pub async fn load_core_into_session(
    session: &Arc<GameSession>,
    core_path: Option<&std::path::Path>,
    content_path: Option<&str>,
    _platform: Option<&str>,
) {
    let core_path_str = match core_path {
        Some(p) => p.to_string_lossy().to_string(),
        None => {
            // Fall back to env var
            std::env::var("GV_CORE_PATH").unwrap_or_else(|_| {
                let mut p = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"));
                p.pop();
                p.push("test-data/cores/2048_libretro.so");
                p.to_string_lossy().to_string()
            })
        }
    };

    let rom_path: Option<std::path::PathBuf> = content_path.map(|s| s.into());
    let save_dir: std::path::PathBuf = std::env::var("GV_SAVE_DIR")
        .unwrap_or_else(|_| "/tmp".into())
        .into();
    let channels: u16 = std::env::var("GV_AUDIO_CHANNELS")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(2);

    let core_config = libretro_runner::CoreConfig {
        core_path: core_path_str.into(),
        content_path: rom_path.clone(),
        system_dir: std::env::var("GV_SYSTEM_DIR")
            .unwrap_or_else(|_| "/tmp".into())
            .into(),
        save_dir,
        audio_channels: channels,
    };

    let mut core = match unsafe { libretro_runner::Core::load(core_config) } {
        Ok(c) => c,
        Err(e) => {
            tracing::warn!("[CORE] Failed to load core: {} — falling back to test pattern", e);
            return;
        }
    };

    let mut sample_rate = core.av_info.sample_rate;
    if sample_rate <= 0.0 {
        if let Err(e) = core.run_frame() {
            tracing::warn!("[CORE] first run_frame failed: {} — audio disabled", e);
        } else {
            sample_rate = core.av_info.sample_rate;
        }
    }

    let width = core.av_info.base_width;
    let height = core.av_info.base_height;
    let fps = core.av_info.fps;
    let frame_interval = Duration::from_secs_f64(1.0 / fps);
    let sram_flush_interval = (fps * 30.0).round() as u64;

    tracing::info!("[CORE] Loaded: {width}×{height} @ {fps:.1}fps, {sample_rate:.0}Hz");

    // ROM hashing + SRAM restore
    let rom_hash: Option<String> = rom_path
        .as_ref()
        .and_then(|p| saves::hash_rom(p));

    if let Some(ref hash) = rom_hash {
        let sram_path = saves::sram_path(hash);
        if sram_path.exists() {
            match std::fs::read(&sram_path) {
                Ok(data) => {
                    core.restore_sram(&data);
                    tracing::info!("[CORE] Restored SRAM from {} ({} bytes)", sram_path.display(), data.len());
                }
                Err(e) => tracing::warn!("[CORE] Failed to read SRAM: {e}"),
            }
        }
    }

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

    std::thread::spawn(move || {
        let mut frame_num: u64 = 0;
        loop {
            let next_tick_start = std::time::Instant::now();

            while let Ok(cmd) = cmd_rx.try_recv() {
                match cmd {
                    CoreCommand::SetJoypad { port, button, pressed } => {
                        core.set_joypad(port, button, pressed);
                    }
                    CoreCommand::SetInput { port, state } => {
                        tracing::info!("[CORE] SetInput port={} state=0x{:04X}", port, state);
                        core.set_input(port, state);
                    }
                    CoreCommand::SaveState { slot } => {
                        handle_save_state(&core, slot, rom_hash.as_deref(), &response_tx);
                    }
                    CoreCommand::LoadState { slot } => {
                        // core is moved into thread — can't pass &mut through handle_load_state easily
                        let ok = match rom_hash {
                            Some(ref hash) => {
                                let path = saves::state_path(hash, slot);
                                match std::fs::read(&path) {
                                    Ok(data) => {
                                        let success = core.load_state(&data);
                                        if success {
                                            tracing::info!("[CORE] Loaded state slot {} ({} bytes)", slot, data.len());
                                        }
                                        success
                                    }
                                    Err(_) => false,
                                }
                            }
                            None => false,
                        };
                        let _ = response_tx.send(CoreResponse::LoadStateResult { slot, ok });
                    }
                    CoreCommand::Reset => core.reset(),
                    CoreCommand::DiskEject => core.disk_eject(),
                    CoreCommand::DiskInsert { index } => core.disk_insert(index),
                }
            }

            if let Err(e) = core.run_frame() {
                tracing::error!("[CORE] run_frame failed: {e} — exiting core thread");
                let _ = frame_tx.send(CoreFrame {
                    pixels: Vec::new(),
                    width: 0,
                    height: 0,
                    audio: Vec::new(),
                });
                break;
            }

            if let Some(frame_data) = core.frame() {
                let audio = core.drain_audio();
                let frame = CoreFrame {
                    pixels: frame_data.to_vec(),
                    width: core.frame_size().0,
                    height: core.frame_size().1,
                    audio,
                };
                if frame_tx.send(frame).is_err() {
                    break;
                }
            }

            frame_num = frame_num.wrapping_add(1);

            let elapsed = next_tick_start.elapsed();
            if let Some(remaining) = frame_interval.checked_sub(elapsed) {
                if !remaining.is_zero() {
                    std::thread::sleep(remaining);
                }
            }

            if frame_num > 0 && frame_num.is_multiple_of(sram_flush_interval) {
                if let Some(ref hash) = rom_hash {
                    if let Some(sram_data) = core.sram() {
                        if !sram_data.is_empty() {
                            let path = saves::sram_path(hash);
                            let _ = saves::write_atomic(&path, &sram_data);
                        }
                    }
                }
            }
        }

        // Save SRAM on exit
        if let Some(ref hash) = rom_hash {
            if let Some(sram_data) = core.sram() {
                if !sram_data.is_empty() {
                    let path = saves::sram_path(hash);
                    let _ = saves::write_atomic(&path, &sram_data);
                }
            }
        }
    });
}
