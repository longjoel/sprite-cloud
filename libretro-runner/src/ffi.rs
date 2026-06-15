//! Raw FFI types matching the libretro C API.
//!
//! Declared by hand to avoid external FFI crate dependencies.
//! Reference: `libretro.h` (RetroArch/libretro-common).
//!
//! # Safety
//!
//! All function pointer types in this module are `unsafe extern "C"`.
//! Callers must ensure the function pointer is valid, the library is
//! still loaded, and the ABI contract is followed.
//!
//! Many FFI constants and type aliases are declared for completeness
//! but not yet used by the runner — silence dead-code warnings until
//! they are wired into real callbacks and input mapping.

#![allow(dead_code)]

use std::ffi::{c_char, c_void};

// ---------------------------------------------------------------------------
// Callback function types (host → core)
// ---------------------------------------------------------------------------

/// Environment callback — core calls this to query/configure the frontend.
pub type RetroEnvironmentFn = unsafe extern "C" fn(cmd: u32, data: *mut c_void) -> bool;

// ---------------------------------------------------------------------------
// Video
// ---------------------------------------------------------------------------

/// Video refresh callback — core calls this each frame with the rendered pixels.
/// `data` is null for duplicate frames or HW-rendered cores.
pub type RetroVideoRefreshFn =
    unsafe extern "C" fn(data: *const c_void, width: u32, height: u32, pitch: usize);

// ---------------------------------------------------------------------------
// Audio
// ---------------------------------------------------------------------------

/// Audio sample callback — core calls this per-sample (fallback).
pub type RetroAudioSampleFn = unsafe extern "C" fn(left: i16, right: i16);

/// Audio sample batch callback — core calls this with a buffer of interleaved samples.
/// Returns the number of frames consumed.
pub type RetroAudioSampleBatchFn =
    unsafe extern "C" fn(data: *const i16, frames: usize) -> usize;

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

/// Input poll callback — core calls this before reading input state.
pub type RetroInputPollFn = unsafe extern "C" fn();

/// Input state callback — core calls this to read button/axis state.
/// Returns 0 for unpressed, 0x7FFF for fully pressed (joypad) or -32767..32767 (analog).
pub type RetroInputStateFn =
    unsafe extern "C" fn(port: u32, device: u32, index: u32, id: u32) -> i16;

// ---------------------------------------------------------------------------
// Core lifecycle function pointer types (loaded from the .so)
// ---------------------------------------------------------------------------

pub type RetroSetEnvironment = unsafe extern "C" fn(cb: RetroEnvironmentFn);
pub type RetroSetVideoRefresh = unsafe extern "C" fn(cb: RetroVideoRefreshFn);
pub type RetroSetAudioSample = unsafe extern "C" fn(cb: RetroAudioSampleFn);
pub type RetroSetAudioSampleBatch = unsafe extern "C" fn(cb: RetroAudioSampleBatchFn);
pub type RetroSetInputPoll = unsafe extern "C" fn(cb: RetroInputPollFn);
pub type RetroSetInputState = unsafe extern "C" fn(cb: RetroInputStateFn);

pub type RetroInit = unsafe extern "C" fn();
pub type RetroDeinit = unsafe extern "C" fn();
pub type RetroRun = unsafe extern "C" fn();
pub type RetroReset = unsafe extern "C" fn();

pub type RetroLoadGame = unsafe extern "C" fn(game: *const RetroGameInfo) -> bool;
pub type RetroUnloadGame = unsafe extern "C" fn();

pub type RetroGetMemoryData = unsafe extern "C" fn(id: u32) -> *mut c_void;
pub type RetroGetMemorySize = unsafe extern "C" fn(id: u32) -> usize;

pub type RetroSerializeSize = unsafe extern "C" fn() -> usize;
pub type RetroSerialize = unsafe extern "C" fn(data: *mut c_void, size: usize) -> bool;
pub type RetroUnserialize = unsafe extern "C" fn(data: *const c_void, size: usize) -> bool;

pub type RetroGetSystemInfo = unsafe extern "C" fn(info: *mut RetroSystemInfo);
pub type RetroGetSystemAvInfo = unsafe extern "C" fn(info: *mut RetroSystemAvInfo);

// ---------------------------------------------------------------------------
// Structs (match libretro.h layout exactly)
// ---------------------------------------------------------------------------

/// Passed to `retro_load_game()`.
#[repr(C)]
#[derive(Debug, Clone)]
pub struct RetroGameInfo {
    /// Path to the ROM file (null-terminated C string, or null).
    pub path: *const c_char,
    /// Preloaded ROM data (null if using `need_fullpath`).
    pub data: *const c_void,
    /// Size of preloaded data in bytes.
    pub size: usize,
    /// Optional metadata (unused — always null).
    pub meta: *const c_char,
}

/// Video geometry reported by the core.
#[repr(C)]
#[derive(Debug, Clone, Copy)]
pub struct RetroGameGeometry {
    /// Base width in pixels (before aspect ratio correction).
    pub base_width: u32,
    /// Base height in pixels.
    pub base_height: u32,
    /// Maximum width the core can output.
    pub max_width: u32,
    /// Maximum height the core can output.
    pub max_height: u32,
    /// Display aspect ratio (width / height).
    pub aspect_ratio: f32,
}

/// Timing information reported by the core.
#[repr(C)]
#[derive(Debug, Clone, Copy)]
pub struct RetroSystemTiming {
    /// Frames per second.
    pub fps: f64,
    /// Audio sample rate in Hz.
    pub sample_rate: f64,
}

/// Combined AV info from `retro_get_system_av_info()`.
#[repr(C)]
#[derive(Debug, Clone, Copy)]
pub struct RetroSystemAvInfo {
    pub geometry: RetroGameGeometry,
    pub timing: RetroSystemTiming,
}

/// System info from `retro_get_system_info()`.
#[repr(C)]
#[derive(Debug, Clone)]
pub struct RetroSystemInfo {
    /// Human-readable library name.
    pub library_name: *const c_char,
    /// Library version string.
    pub library_version: *const c_char,
    /// Pipe-separated list of valid ROM extensions.
    pub valid_extensions: *const c_char,
    /// Core needs the real file path (can't load from memory).
    pub need_fullpath: bool,
    /// Core expects the ROM to be extracted (not zipped).
    pub block_extract: bool,
}

// ---------------------------------------------------------------------------
// Environment command constants
// ---------------------------------------------------------------------------

/// Set the pixel format the frontend expects.
pub const RETRO_ENVIRONMENT_SET_PIXEL_FORMAT: u32 = 10;
/// Get the system directory path.
pub const RETRO_ENVIRONMENT_GET_SYSTEM_DIRECTORY: u32 = 9;
/// Get the save directory path.
pub const RETRO_ENVIRONMENT_GET_SAVE_DIRECTORY: u32 = 31;
/// Get a core variable value by key.
pub const RETRO_ENVIRONMENT_GET_VARIABLE: u32 = 15;
/// Set available core variables.
pub const RETRO_ENVIRONMENT_SET_VARIABLES: u32 = 16;
/// Check if any core variables have been updated.
pub const RETRO_ENVIRONMENT_GET_VARIABLE_UPDATE: u32 = 17;
/// Get the preferred hardware render API.
pub const RETRO_ENVIRONMENT_GET_PREFERRED_HW_RENDER: u32 = 69;
/// Core declares it can run without a game loaded.
pub const RETRO_ENVIRONMENT_SET_SUPPORT_NO_GAME: u32 = 18;

// ---------------------------------------------------------------------------
// Device types
// ---------------------------------------------------------------------------

/// Standard joypad (RETRO_DEVICE_JOYPAD).
pub const RETRO_DEVICE_JOYPAD: u32 = 1;
/// Analog stick (RETRO_DEVICE_ANALOG).
pub const RETRO_DEVICE_ANALOG: u32 = 5;
/// Keyboard (RETRO_DEVICE_KEYBOARD).
pub const RETRO_DEVICE_KEYBOARD: u32 = 3;

// ---------------------------------------------------------------------------
// Memory types
// ---------------------------------------------------------------------------

/// Battery-backed save RAM (SRAM).
pub const RETRO_MEMORY_SAVE_RAM: u32 = 0;

// ---------------------------------------------------------------------------
// Pixel formats
// ---------------------------------------------------------------------------

/// 32-bit XRGB8888 (alpha byte ignored).
pub const RETRO_PIXEL_FORMAT_XRGB8888: u32 = 1;
/// 16-bit RGB565.
pub const RETRO_PIXEL_FORMAT_RGB565: u32 = 2;
/// 16-bit 0RGB1555.
pub const RETRO_PIXEL_FORMAT_0RGB1555: u32 = 0;

// ---------------------------------------------------------------------------
// Joypad button IDs (RETRO_DEVICE_ID_JOYPAD_*)
// ---------------------------------------------------------------------------

/// B button (index 0 in SNES layout).
pub const RETRO_DEVICE_ID_JOYPAD_B: u32 = 0;
/// Y button.
pub const RETRO_DEVICE_ID_JOYPAD_Y: u32 = 1;
/// Select button.
pub const RETRO_DEVICE_ID_JOYPAD_SELECT: u32 = 2;
/// Start button.
pub const RETRO_DEVICE_ID_JOYPAD_START: u32 = 3;
/// D-pad up.
pub const RETRO_DEVICE_ID_JOYPAD_UP: u32 = 4;
/// D-pad down.
pub const RETRO_DEVICE_ID_JOYPAD_DOWN: u32 = 5;
/// D-pad left.
pub const RETRO_DEVICE_ID_JOYPAD_LEFT: u32 = 6;
/// D-pad right.
pub const RETRO_DEVICE_ID_JOYPAD_RIGHT: u32 = 7;
/// A button.
pub const RETRO_DEVICE_ID_JOYPAD_A: u32 = 8;
/// X button.
pub const RETRO_DEVICE_ID_JOYPAD_X: u32 = 9;
/// Left shoulder.
pub const RETRO_DEVICE_ID_JOYPAD_L: u32 = 10;
/// Right shoulder.
pub const RETRO_DEVICE_ID_JOYPAD_R: u32 = 11;
/// Left trigger.
pub const RETRO_DEVICE_ID_JOYPAD_L2: u32 = 12;
/// Right trigger.
pub const RETRO_DEVICE_ID_JOYPAD_R2: u32 = 13;
/// Left stick button.
pub const RETRO_DEVICE_ID_JOYPAD_L3: u32 = 14;
/// Right stick button.
pub const RETRO_DEVICE_ID_JOYPAD_R3: u32 = 15;
/// Full 16-bit button mask (returns entire state as one value).
pub const RETRO_DEVICE_ID_JOYPAD_MASK: u32 = 256;

// ---------------------------------------------------------------------------
// Analog axis indices (RETRO_DEVICE_INDEX_ANALOG_*)
// ---------------------------------------------------------------------------

/// Left analog stick.
pub const RETRO_DEVICE_INDEX_ANALOG_LEFT: u32 = 0;
/// Right analog stick.
pub const RETRO_DEVICE_INDEX_ANALOG_RIGHT: u32 = 1;

/// X axis.
pub const RETRO_DEVICE_ID_ANALOG_X: u32 = 0;
/// Y axis.
pub const RETRO_DEVICE_ID_ANALOG_Y: u32 = 1;
