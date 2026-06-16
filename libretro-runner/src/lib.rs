//! Synchronous libretro core runner.
//!
//! Loads a libretro shared library, runs it frame-by-frame,
//! and captures video (RGB24) and audio (interleaved i16 PCM) output.
//!
//! # Example
//!
//! ```no_run
//! use libretro_runner::{Core, CoreConfig};
//!
//! let core = unsafe {
//!     Core::load(CoreConfig {
//!         core_path: "/usr/lib/libretro/gambatte.so".into(),
//!         content_path: Some("/roms/game.gb".into()),
//!         system_dir: "/srv/storage/games/system".into(),
//!         save_dir: "/srv/storage/games/saves".into(),
//!         audio_channels: 2,
//!     })?
//! };
//!
//! println!("Core loaded: {}x{} @ {}fps",
//!     core.av_info.base_width, core.av_info.base_height, core.av_info.fps);
//! # Ok::<(), Box<dyn std::error::Error>>(())
//! ```

// Every unsafe operation must be inside an explicit `unsafe {}` block
// with a `// SAFETY:` comment explaining why it's sound.
#![deny(unsafe_op_in_unsafe_fn)]

mod ffi;
mod info;
mod runner;

pub use crate::runner::Core;
pub use info::{CoreInfo, FirmwareFile, check_firmware, detect_core, discover_cores, parse_info};

use std::path::PathBuf;

/// Errors that can occur during core operations.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("failed to load core library: {0}")]
    Load(#[from] libloading::Error),

    #[error("{0}")]
    Other(String),
}

/// Configuration for loading a libretro core.
#[derive(Debug, Clone)]
pub struct CoreConfig {
    pub core_path: PathBuf,
    pub content_path: Option<PathBuf>,
    pub system_dir: PathBuf,
    pub save_dir: PathBuf,
    /// Number of audio channels the core outputs (default: 2 for stereo).
    /// Set to 1 for mono cores (Game Boy, Game Boy Color, some arcade).
    pub audio_channels: u16,
}

impl Default for CoreConfig {
    fn default() -> Self {
        Self {
            core_path: PathBuf::new(),
            content_path: None,
            system_dir: PathBuf::from("/tmp"),
            save_dir: PathBuf::from("/tmp"),
            audio_channels: 2,
        }
    }
}

/// Audio/video information reported by the core.
#[derive(Debug, Clone, Copy)]
pub struct AvInfo {
    pub base_width: u32,
    pub base_height: u32,
    pub max_width: u32,
    pub max_height: u32,
    pub aspect_ratio: f32,
    pub fps: f64,
    pub sample_rate: f64,
}

/// Joypad buttons in libretro's SNES-style layout.
///
/// Each variant's discriminant is the `RETRO_DEVICE_ID_JOYPAD_*` index.
/// Use `set_input(port, mask)` to set the full 16-bit state in one call
/// (RetroArch network input protocol). For single-button convenience,
/// compose masks with `JoypadButton::Up as u16`, etc.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum JoypadButton {
    B = 0,
    Y = 1,
    Select = 2,
    Start = 3,
    Up = 4,
    Down = 5,
    Left = 6,
    Right = 7,
    A = 8,
    X = 9,
    L = 10,
    R = 11,
    L2 = 12,
    R2 = 13,
    L3 = 14,
    R3 = 15,
}
