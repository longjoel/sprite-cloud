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
pub type RetroAudioSampleBatchFn = unsafe extern "C" fn(data: *const i16, frames: usize) -> usize;

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
pub type RetroSetControllerPortDevice = unsafe extern "C" fn(port: u32, device: u32);

pub type RetroInit = unsafe extern "C" fn();
pub type RetroDeinit = unsafe extern "C" fn();
pub type RetroRun = unsafe extern "C" fn();

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
/// Core declares it can run without a game loaded.
pub const RETRO_ENVIRONMENT_SET_SUPPORT_NO_GAME: u32 = 18;
/// Query a core variable (set by GET_VARIABLE callback).
pub const RETRO_ENVIRONMENT_GET_VARIABLE: u32 = 15;
/// Frontend declares the set of core variables it supports.
pub const RETRO_ENVIRONMENT_SET_VARIABLES: u32 = 16;
/// Ask whether variables changed since last frame.
pub const RETRO_ENVIRONMENT_GET_VARIABLE_UPDATE: u32 = 17;
/// Return the path to the loaded libretro core.
pub const RETRO_ENVIRONMENT_GET_LIBRETRO_PATH: u32 = 19;
/// Return a log callback so the core can log via the frontend.
pub const RETRO_ENVIRONMENT_GET_LOG_INTERFACE: u32 = 27;
/// Return a performance measurement callback.
pub const RETRO_ENVIRONMENT_GET_PERF_INTERFACE: u32 = 28;
/// Return the core-options version the frontend supports.
pub const RETRO_ENVIRONMENT_GET_CORE_OPTIONS_VERSION: u32 = 52;
/// Register core options (legacy single structure).
pub const RETRO_ENVIRONMENT_SET_CORE_OPTIONS: u32 = 53;
/// Register core options (internationalized structure).
pub const RETRO_ENVIRONMENT_SET_CORE_OPTIONS_INTL: u32 = 54;
/// Register core options (v2 modern structure).
pub const RETRO_ENVIRONMENT_SET_CORE_OPTIONS_V2: u32 = 55;
/// Register core options (v2 internationalized structure).
pub const RETRO_ENVIRONMENT_SET_CORE_OPTIONS_V2_INTL: u32 = 56;
/// Set a callback for when the core wants options display updated.
pub const RETRO_ENVIRONMENT_SET_CORE_OPTIONS_UPDATE_DISPLAY_CALLBACK: u32 = 69;
/// Core requests a hardware-rendering context (data = retro_hw_render_callback*).
pub const RETRO_ENVIRONMENT_SET_HW_RENDER: u32 = 14;

/// Sentinel passed to video_refresh by HW-rendered cores: pixels live in the
/// GL default framebuffer, not in `data`.
pub const RETRO_HW_FRAME_BUFFER_VALID: *const std::ffi::c_void =
    usize::MAX as *const std::ffi::c_void;

/// HW context types (enum retro_hw_context_type).
pub const RETRO_HW_CONTEXT_NONE: u32 = 0;
pub const RETRO_HW_CONTEXT_OPENGL: u32 = 1;
pub const RETRO_HW_CONTEXT_OPENGLES2: u32 = 2;
pub const RETRO_HW_CONTEXT_OPENGL_CORE: u32 = 3;
pub const RETRO_HW_CONTEXT_OPENGLES3: u32 = 4;
pub const RETRO_HW_CONTEXT_OPENGLES_VERSION: u32 = 5;
pub const RETRO_HW_CONTEXT_VULKAN: u32 = 6;

/// A single core variable, passed to `retro_get_variable_callback`.
#[repr(C)]
#[derive(Debug, Clone)]
pub struct RetroVariable {
    /// Variable key (e.g. "corename_option").
    pub key: *const c_char,
    /// Variable value (null-terminated, may be null if unset).
    pub value: *const c_char,
}

/// Log callback signature — matches libretro `retro_log_printf_t`
/// `void (*)(enum retro_log_level, const char *fmt, ...)`. Variadic because the
/// shim must be able to consume a `va_list`.
pub type RetroLogPrintf = unsafe extern "C" fn(level: u32, fmt: *const c_char, ...);

/// `struct retro_log_callback` — the core fills `log`.
#[repr(C)]
#[derive(Clone, Copy)]
pub struct RetroLogCallback {
    /// Frontend-provided logging function.
    pub log: Option<RetroLogPrintf>,
}

/// `enum retro_log_level` values.
pub const RETRO_LOG_DEBUG: u32 = 0;
pub const RETRO_LOG_INFO: u32 = 1;
pub const RETRO_LOG_WARN: u32 = 2;
pub const RETRO_LOG_ERROR: u32 = 3;

// ---------------------------------------------------------------------------
// Device types
// ---------------------------------------------------------------------------

/// Standard joypad (RETRO_DEVICE_JOYPAD).
pub const RETRO_DEVICE_JOYPAD: u32 = 1;

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

/// Full 16-bit button mask (returns entire state as one value).
pub const RETRO_DEVICE_ID_JOYPAD_MASK: u32 = 256;
