//! Bridge between the libretro core (OS thread) and the tokio streaming loop.
//!
//! The core must run on a dedicated OS thread because libretro callbacks
//! use thread-local storage. Frames are sent via a bounded sync channel
//! to the tokio task that encodes and streams them.

use std::sync::mpsc;
use std::time::Duration;

use libretro_runner::{Core, CoreConfig};

/// A frame produced by the core: RGB24 pixels + dimensions.
#[derive(Clone)]
pub struct CoreFrame {
    pub pixels: Vec<u8>,
    #[allow(dead_code)]
    pub width: u32,
    #[allow(dead_code)]
    pub height: u32,
}

/// Spawn a dedicated OS thread that loads the 2048 core (or the core
/// specified by GV_CORE_PATH) and runs it in a loop.
///
/// Returns the frame dimensions and a channel receiver. The thread
/// exits when the receiver is dropped (channel closed).
pub fn spawn_core_thread() -> Option<((u32, u32), mpsc::Receiver<CoreFrame>)> {
    let core_path = std::env::var("GV_CORE_PATH").unwrap_or_else(|_| {
        // Default: 2048 core relative to workspace root
        let mut p = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        p.pop(); // gv-worker dir → workspace root
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

    let (tx, rx) = mpsc::sync_channel::<CoreFrame>(1);

    std::thread::spawn(move || {
        loop {
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
                // sync_channel(1): block until the consumer takes the previous frame.
                // This provides natural backpressure — we don't build up a queue.
                if tx.send(frame).is_err() {
                    // Receiver dropped — streaming stopped
                    break;
                }
            }

            let next_tick = std::time::Instant::now() + frame_interval;
            while std::time::Instant::now() < next_tick {
                std::thread::sleep(Duration::from_millis(1));
            }
        }
    });

    Some(((width, height), rx))
}
