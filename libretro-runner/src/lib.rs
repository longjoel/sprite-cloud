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
//! let mut core = unsafe {
//!     Core::load(CoreConfig {
//!         core_path: "/usr/lib/libretro/gambatte.so".into(),
//!         content_path: Some("/roms/game.gb".into()),
//!         system_dir: "/srv/storage/games/system".into(),
//!         save_dir: "/srv/storage/games/saves".into(),
//!     })?
//! };
//!
//! loop {
//!     core.set_joypad(0, libretro_runner::JoypadButton::A, true);
//!     core.run_frame()?;
//!     let frame = core.frame();
//!     let audio = core.audio();
//!     // stream frame + audio via WebRTC...
//! }
//! # Ok::<(), Box<dyn std::error::Error>>(())
//! ```

// Every unsafe operation must be inside an explicit `unsafe {}` block
// with a `// SAFETY:` comment explaining why it's sound.
#![deny(unsafe_op_in_unsafe_fn)]

mod ffi;
mod info;

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
    /// Path to the libretro shared library (.so/.dll/.dylib).
    pub core_path: PathBuf,

    /// Path to the ROM/game content file (optional — cores that support
    /// no-game mode don't need one).
    pub content_path: Option<PathBuf>,

    /// Directory containing BIOS/system files.
    pub system_dir: PathBuf,

    /// Directory for save files (SRAM, save states).
    pub save_dir: PathBuf,
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
/// Indices match `RETRO_DEVICE_ID_JOYPAD_*`:
/// 0=B, 1=Y, 2=Select, 3=Start, 4=Up, 5=Down, 6=Left, 7=Right,
/// 8=A, 9=X, 10=L, 11=R, 12=L2, 13=R2, 14=L3, 15=R3
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

/// A loaded libretro core. Created via [`Core::load`].
pub struct Core {
    _private: (), // populated in later tasks
}

impl Core {
    /// Load a libretro core, initialize it, and load content.
    ///
    /// # Safety
    ///
    /// `config.core_path` must point to a valid libretro shared library.
    /// The core runs native code — this executes `dlopen` and `retro_init()`.
    pub unsafe fn load(_config: CoreConfig) -> Result<Self, Error> {
        Err(Error::Other("not yet implemented".into()))
    }

    /// Audio/video info from the loaded core.
    pub fn av_info(&self) -> AvInfo {
        AvInfo {
            base_width: 320,
            base_height: 240,
            max_width: 320,
            max_height: 240,
            aspect_ratio: 1.0,
            fps: 60.0,
            sample_rate: 48000.0,
        }
    }

    /// Run one frame of the emulator.
    pub fn run_frame(&mut self) -> Result<(), Error> {
        Err(Error::Other("not yet implemented".into()))
    }

    /// Set a joypad button state for the given player port.
    pub fn set_joypad(&mut self, _port: u32, _button: JoypadButton, _pressed: bool) {}

    /// Get the current video frame as RGB24 bytes, if available.
    pub fn frame(&self) -> Option<&[u8]> {
        None
    }

    /// Dimensions of the current video frame.
    pub fn frame_size(&self) -> (u32, u32) {
        (320, 240)
    }

    /// Get accumulated audio samples since the last frame.
    pub fn audio(&self) -> &[i16] {
        &[]
    }

    /// Read the core's battery-backed save RAM.
    pub fn sram(&self) -> Result<Vec<u8>, Error> {
        Err(Error::Other("not yet implemented".into()))
    }

    /// Restore battery-backed save RAM into the core.
    pub fn restore_sram(&mut self, _data: &[u8]) -> Result<(), Error> {
        Err(Error::Other("not yet implemented".into()))
    }

    /// Capture a full save state.
    pub fn save_state(&self) -> Result<Vec<u8>, Error> {
        Err(Error::Other("not yet implemented".into()))
    }

    /// Restore a full save state.
    pub fn load_state(&mut self, _data: &[u8]) -> Result<(), Error> {
        Err(Error::Other("not yet implemented".into()))
    }
}
