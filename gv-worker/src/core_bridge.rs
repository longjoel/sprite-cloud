//! Bridge between the libretro core (OS thread) and the tokio streaming loop.
//!
//! The core must run on a dedicated OS thread because libretro callbacks
//! use thread-local storage. Frames are sent via a bounded sync channel
//! to the tokio task that encodes and streams them. Input commands flow
//! in the opposite direction via a separate channel.

use std::sync::mpsc::{self, Receiver, SyncSender};
use std::time::Duration;

use libretro_runner::{Core, CoreConfig, JoypadButton};

/// A frame produced by the core: RGB24 pixels + dimensions.
#[derive(Clone)]
pub struct CoreFrame {
    pub pixels: Vec<u8>,
    #[allow(dead_code)]
    pub width: u32,
    #[allow(dead_code)]
    pub height: u32,
}

/// Commands sent from the streaming task to the core thread.
#[derive(Clone, Copy)]
pub enum CoreCommand {
    SetJoypad { port: u32, button: JoypadButton, pressed: bool },
}

/// Handle returned from `spawn_core_thread`.
pub struct CoreHandle {
    pub width: u32,
    pub height: u32,
    pub frame_rx: Receiver<CoreFrame>,
    pub cmd_tx: SyncSender<CoreCommand>,
}

/// Spawn a dedicated OS thread that loads the 2048 core (or the core
/// specified by GV_CORE_PATH) and runs it in a loop.
///
/// Returns a `CoreHandle` with frame dimensions, frame receiver, and
/// a command sender. The thread exits when the frame receiver is dropped.
pub fn spawn_core_thread() -> Option<CoreHandle> {
    let core_path = std::env::var("GV_CORE_PATH").unwrap_or_else(|_| {
        let mut p = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        p.pop();
        p.push("test-data/cores/2048_libretro.so");
        p.to_string_lossy().to_string()
    });

    let rom_path = std::env::var("GV_CONTENT_PATH").ok();

    let core_config = CoreConfig {
        core_path: core_path.into(),
        content_path: rom_path.map(|s| s.into()),
        system_dir: std::env::var("GV_SYSTEM_DIR")
            .unwrap_or_else(|_| "/tmp".into())
            .into(),
        save_dir: std::env::var("GV_SAVE_DIR")
            .unwrap_or_else(|_| "/tmp".into())
            .into(),
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

    let width = core.av_info.base_width;
    let height = core.av_info.base_height;
    let fps = core.av_info.fps;
    let frame_interval = Duration::from_secs_f64(1.0 / fps);

    tracing::info!(
        "[CORE] Loaded: {}×{} @ {:.1}fps, {:.0}Hz",
        width, height, fps, core.av_info.sample_rate
    );

    let (frame_tx, frame_rx) = mpsc::sync_channel::<CoreFrame>(1);
    let (cmd_tx, cmd_rx) = mpsc::sync_channel::<CoreCommand>(16);

    std::thread::spawn(move || {
        loop {
            // Drain pending input commands
            while let Ok(cmd) = cmd_rx.try_recv() {
                match cmd {
                    CoreCommand::SetJoypad { port, button, pressed } => {
                        core.set_joypad(port, button, pressed);
                    }
                }
            }

            if let Err(e) = core.run_frame() {
                tracing::error!("[CORE] run_frame failed: {} — exiting core thread", e);
                break;
            }

            if let Some(frame_data) = core.frame() {
                let frame = CoreFrame {
                    pixels: frame_data.to_vec(),
                    width: core.frame_size().0,
                    height: core.frame_size().1,
                };
                if frame_tx.send(frame).is_err() {
                    break;
                }
            }

            let next_tick = std::time::Instant::now() + frame_interval;
            while std::time::Instant::now() < next_tick {
                std::thread::sleep(Duration::from_millis(1));
            }
        }
    });

    Some(CoreHandle {
        width,
        height,
        frame_rx,
        cmd_tx,
    })
}
