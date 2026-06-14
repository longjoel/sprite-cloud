//! Core loading and lifecycle.
//!
//! Handles dlopen, symbol lookup, callback registration, and retro_init.
//! Content loading and the run loop come in later tasks.

use std::ffi::CStr;

use libloading::Library;

use crate::ffi::*;
use crate::{AvInfo, CoreConfig, Error};

// ---------------------------------------------------------------------------
// Symbol loading helpers
// ---------------------------------------------------------------------------

/// Load a required symbol from the library.
///
/// # Safety
///
/// The library must remain loaded for the lifetime of the returned function
/// pointer. The caller guarantees the symbol name and signature match the
/// libretro ABI.
unsafe fn load_symbol<T: Copy>(lib: &Library, name: &CStr) -> Result<T, Error> {
    // SAFETY: caller guarantees the symbol exists and has the correct type.
    unsafe {
        lib.get::<T>(name.to_bytes_with_nul())
            .map(|sym| *sym)
            .map_err(|e| Error::Load(e))
    }
}

/// Load an optional symbol from the library. Returns None if not found.
///
/// # Safety
///
/// Same preconditions as `load_symbol`, but the symbol may not exist.
unsafe fn load_optional_symbol<T: Copy>(lib: &Library, name: &CStr) -> Option<T> {
    // SAFETY: caller guarantees the symbol (if present) has the correct type.
    unsafe { lib.get::<T>(name.to_bytes_with_nul()).ok().map(|sym| *sym) }
}

// ---------------------------------------------------------------------------
// Core struct
// ---------------------------------------------------------------------------

/// A loaded libretro core.
pub struct Core {
    /// Must be dropped last — the library must outlive all function pointers.
    _library: Library,

    /// Required function pointers.
    retro_run: RetroRun,
    retro_load_game: RetroLoadGame,
    retro_unload_game: RetroUnloadGame,

    /// Optional function pointers.
    retro_get_memory_data: Option<RetroGetMemoryData>,
    retro_get_memory_size: Option<RetroGetMemorySize>,
    retro_serialize_size: Option<RetroSerializeSize>,
    retro_serialize: Option<RetroSerialize>,
    retro_unserialize: Option<RetroUnserialize>,

    /// Audio/video info from the core.
    pub av_info: AvInfo,
}

impl Core {
    /// Load a libretro core, initialize it, and prepare for content loading.
    ///
    /// This does NOT load game content — `load_content()` must be called
    /// after this if `config.content_path` is set.
    ///
    /// # Safety
    ///
    /// `config.core_path` must point to a valid libretro shared library.
    /// The core runs native code — this executes `dlopen`, `retro_init()`,
    /// and registers callbacks that the core will invoke during `retro_run()`.
    /// The caller must ensure the core is a trusted libretro implementation.
    pub unsafe fn load(config: CoreConfig) -> Result<Self, Error> {
        // SAFETY: caller guarantees the path points to a valid shared library.
        let library = unsafe {
            Library::new(&config.core_path)
                .map_err(|e| Error::Load(e))?
        };

        // SAFETY: each load_symbol call looks up a named symbol from the
        // loaded library. The libretro ABI mandates these exact symbol names
        // and function signatures. The library is kept alive in `_library`.
        let retro_run = unsafe { load_symbol::<RetroRun>(&library, c"retro_run") }?;
        let retro_load_game =
            unsafe { load_symbol::<RetroLoadGame>(&library, c"retro_load_game") }?;
        let retro_unload_game =
            unsafe { load_symbol::<RetroUnloadGame>(&library, c"retro_unload_game") }?;

        let retro_get_memory_data =
            unsafe { load_optional_symbol::<RetroGetMemoryData>(
                &library, c"retro_get_memory_data") };
        let retro_get_memory_size =
            unsafe { load_optional_symbol::<RetroGetMemorySize>(
                &library, c"retro_get_memory_size") };
        let retro_serialize_size =
            unsafe { load_optional_symbol::<RetroSerializeSize>(
                &library, c"retro_serialize_size") };
        let retro_serialize =
            unsafe { load_optional_symbol::<RetroSerialize>(
                &library, c"retro_serialize") };
        let retro_unserialize =
            unsafe { load_optional_symbol::<RetroUnserialize>(
                &library, c"retro_unserialize") };

        // Initialize the core — callbacks are registered in Task 5-7.
        // For now: stub callbacks that do nothing.
        // SAFETY: retro_init must be called once before any other core
        // operations. The library is valid and loaded.
        let retro_init = unsafe { load_symbol::<RetroInit>(&library, c"retro_init") }?;
        // SAFETY: retro_set_environment registers our environment callback.
        // The callback is a safe Rust function that matches the ABI.
        let retro_set_environment = unsafe {
            load_symbol::<RetroSetEnvironment>(&library, c"retro_set_environment")
        }?;
        // Register stub callbacks
        unsafe extern "C" fn stub_video_refresh(
            _data: *const std::ffi::c_void, _width: u32, _height: u32, _pitch: usize,
        ) {}
        unsafe extern "C" fn stub_audio_batch(
            _data: *const i16, _frames: usize,
        ) -> usize { 0 }
        unsafe extern "C" fn stub_input_poll() {}
        unsafe extern "C" fn stub_input_state(
            _port: u32, _device: u32, _index: u32, _id: u32,
        ) -> i16 { 0 }

        let retro_set_video_refresh = unsafe {
            load_symbol::<RetroSetVideoRefresh>(&library, c"retro_set_video_refresh")
        }?;
        let retro_set_audio_sample_batch = unsafe {
            load_symbol::<RetroSetAudioSampleBatch>(&library, c"retro_set_audio_sample_batch")
        }?;
        let retro_set_input_poll = unsafe {
            load_symbol::<RetroSetInputPoll>(&library, c"retro_set_input_poll")
        }?;
        let retro_set_input_state = unsafe {
            load_symbol::<RetroSetInputState>(&library, c"retro_set_input_state")
        }?;

        // SAFETY: registering callbacks before retro_init. The callbacks
        // are valid function pointers that match the libretro ABI.
        unsafe { retro_set_environment(stub_environment) };
        unsafe { retro_set_video_refresh(stub_video_refresh) };
        unsafe { retro_set_audio_sample_batch(stub_audio_batch) };
        unsafe { retro_set_input_poll(stub_input_poll) };
        unsafe { retro_set_input_state(stub_input_state) };

        // SAFETY: retro_init initializes the core. Must be paired with
        // retro_deinit (called in Drop).
        unsafe { retro_init() };

        Ok(Core {
            _library: library,
            retro_run,
            retro_load_game,
            retro_unload_game,
            retro_get_memory_data,
            retro_get_memory_size,
            retro_serialize_size,
            retro_serialize,
            retro_unserialize,
            av_info: AvInfo {
                base_width: 320,
                base_height: 240,
                max_width: 320,
                max_height: 240,
                aspect_ratio: 1.0,
                fps: 60.0,
                sample_rate: 48000.0,
            },
        })
    }
}

// ---------------------------------------------------------------------------
// Stub callbacks (replaced in Tasks 5-7)
// ---------------------------------------------------------------------------

/// Stub environment callback — handles the minimum commands needed for
/// retro_init to succeed. Real implementation in Task 5.
unsafe extern "C" fn stub_environment(cmd: u32, _data: *mut std::ffi::c_void) -> bool {
    match cmd {
        // Accept XRGB8888 pixel format
        RETRO_ENVIRONMENT_SET_PIXEL_FORMAT => true,
        // For all other commands, return false (core will try fallbacks)
        _ => false,
    }
}
