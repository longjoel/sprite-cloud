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
}

/// Responses sent from the core thread back to the streaming task.
pub enum CoreResponse {
    SaveStateResult { slot: u8, data: Vec<u8>, ok: bool },
    LoadStateResult { slot: u8, ok: bool },
}

/// Handle returned from `spawn_core_thread`.
pub struct CoreHandle {
    pub width: u32,
    pub height: u32,
    /// Core's actual frame rate (e.g. 59.94 for NES, 60.0 for most).
    pub fps: f64,
    pub sample_rate: f64,
    pub frame_rx: Receiver<CoreFrame>,
    pub cmd_tx: SyncSender<CoreCommand>,
    pub response_rx: Receiver<CoreResponse>,
}

/// Spawn a dedicated OS thread that loads the core specified by GV_CORE_PATH
/// (or falls back to 2048) and runs it in a loop.
///
/// Returns a `CoreHandle` with frame dimensions, frame receiver,
/// command sender, and response receiver.
pub fn spawn_core_thread() -> Option<CoreHandle> {
    let core_path = std::env::var("GV_CORE_PATH").unwrap_or_else(|_| {
        let mut p = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        p.pop();
        p.push("test-data/cores/2048_libretro.so");
        p.to_string_lossy().to_string()
    });

    let rom_path: Option<PathBuf> = std::env::var("GV_CONTENT_PATH").ok().map(|s| s.into());

    let save_dir: PathBuf = std::env::var("GV_SAVE_DIR")
        .unwrap_or_else(|_| "/tmp".into())
        .into();

    let core_config = CoreConfig {
        core_path: core_path.into(),
        content_path: rom_path.clone(),
        system_dir: std::env::var("GV_SYSTEM_DIR")
            .unwrap_or_else(|_| "/tmp".into())
            .into(),
        save_dir,
    };

    // SAFETY: the core is loaded in a dedicated thread. The core path
    // comes from env vars or defaults to the trusted 2048 core.
    let mut core = match unsafe { Core::load(core_config) } {
        Ok(c) => c,
        Err(e) => {
            tracing::warn!("[CORE] Failed to load core: {} — falling back to test pattern", e);
            return None;
        }
    };

    let mut sample_rate = core.av_info.sample_rate;

    // Some cores (e.g. nestopia) report sample_rate=0 after load and only
    // set it properly after the first retro_run().  Run one dummy frame
    // so we can capture the real rate for the audio pipeline.
    if sample_rate <= 0.0 {
        tracing::info!(
            "[CORE] sample_rate={:.0} after load — running one frame to discover real rate",
            sample_rate
        );
        if let Err(e) = core.run_frame() {
            tracing::warn!(
                "[CORE] first run_frame failed: {} — audio disabled",
                e
            );
        } else {
            sample_rate = core.av_info.sample_rate;
            tracing::info!(
                "[CORE] sample_rate after first frame: {:.0}Hz",
                sample_rate
            );
        }
    }

    let width = core.av_info.base_width;
    let height = core.av_info.base_height;
    let fps = core.av_info.fps;
    let frame_interval = Duration::from_secs_f64(1.0 / fps);

    // SRAM flush every 30s (in frames) — derived from actual core FPS
    // instead of a hardcoded constant.
    let sram_flush_interval = (fps * 30.0).round() as u64;

    tracing::info!(
        "[CORE] Loaded: {}×{} @ {:.1}fps, {:.0}Hz",
        width, height, fps, core.av_info.sample_rate
    );

    // ---- ROM hashing + SRAM restore ----//
    let rom_hash: Option<String> = rom_path
        .as_ref()
        .and_then(|p| saves::hash_rom(p));

    if let Some(ref hash) = rom_hash {
        tracing::info!("[CORE] ROM hash: {}", hash);

        // Restore battery SRAM if present
        let sram_path = saves::sram_path(hash);
        if sram_path.exists() {
            match std::fs::read(&sram_path) {
                Ok(data) => {
                    core.restore_sram(&data);
                    tracing::info!(
                        "[CORE] Restored SRAM from {} ({} bytes)",
                        sram_path.display(),
                        data.len()
                    );
                }
                Err(e) => {
                    tracing::warn!(
                        "[CORE] Failed to read SRAM at {}: {}",
                        sram_path.display(),
                        e
                    );
                }
            }
        } else {
            tracing::info!("[CORE] No existing SRAM file — starting fresh");
        }
    }

    let (frame_tx, frame_rx) = mpsc::sync_channel::<CoreFrame>(1);
    let (cmd_tx, cmd_rx) = mpsc::sync_channel::<CoreCommand>(16);
    let (response_tx, response_rx) = mpsc::sync_channel::<CoreResponse>(4);

    std::thread::spawn(move || {
        let mut frame_num: u64 = 0;
        loop {
            // Snapshot time at loop entry for frame pacing
            let next_tick_start = std::time::Instant::now();

            // Drain pending input commands
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
                        handle_load_state(&mut core, slot, rom_hash.as_deref(), &response_tx);
                    }
                }
            }

            if let Err(e) = core.run_frame() {
                tracing::error!("[CORE] run_frame failed: {} — exiting core thread", e);
                // Send sentinel None so the streaming loop knows we died
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

            // Pace the core to its native frame rate.
            // Measure how long run + drain took, then sleep the remainder.
            let elapsed = next_tick_start.elapsed();
            if let Some(remaining) = frame_interval.checked_sub(elapsed) {
                if !remaining.is_zero() {
                    std::thread::sleep(remaining);
                }
            } else if frame_num > 0 && frame_num.is_multiple_of(300) {
                // Only log periodically — a single slow frame is normal
                // (e.g. GC pause, OS scheduler). Log every ~5s at 60fps.
                tracing::warn!(
                    "[CORE] Frame {} took {:?} (target {:?}) — falling behind",
                    frame_num, elapsed, frame_interval,
                );
            }

            // Periodic SRAM flush: write battery saves every 30s
            // so a process kill doesn't lose hours of progress.
            if frame_num > 0 && frame_num.is_multiple_of(sram_flush_interval) {
                if let Some(ref hash) = rom_hash {
                    if let Some(sram_data) = core.sram() {
                        if !sram_data.is_empty() {
                            let path = saves::sram_path(hash);
                            match saves::write_atomic(&path, &sram_data) {
                                Ok(()) => tracing::info!(
                                    "[CORE] Periodic SRAM flush to {} ({} bytes)",
                                    path.display(),
                                    sram_data.len(),
                                ),
                                Err(e) => tracing::warn!(
                                    "[CORE] Periodic SRAM flush failed: {}",
                                    e,
                                ),
                            }
                        }
                    }
                }
            }
        }

        // ---- Save SRAM before core is dropped ----//
        if let Some(ref hash) = rom_hash {
            if let Some(sram_data) = core.sram() {
                if !sram_data.is_empty() {
                    let path = saves::sram_path(hash);
                    match saves::write_atomic(&path, &sram_data) {
                        Ok(()) => tracing::info!(
                            "[CORE] Saved SRAM to {} ({} bytes)",
                            path.display(),
                            sram_data.len()
                        ),
                        Err(e) => tracing::error!(
                            "[CORE] Failed to save SRAM to {}: {}",
                            path.display(),
                            e
                        ),
                    }
                }
            }
        }
        // core is dropped here → retro_unload_game() + retro_deinit()
    });

    Some(CoreHandle {
        width,
        height,
        fps,
        sample_rate,
        frame_rx,
        cmd_tx,
        response_rx,
    })
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
