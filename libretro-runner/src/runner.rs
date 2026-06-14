//! Core loading and lifecycle.
//!
//! Handles dlopen, symbol lookup, callback registration, retro_init,
//! content loading, and AV info extraction.

use std::cell::{Cell, RefCell};
use std::ffi::{CStr, CString};
use std::path::Path;
use std::ptr;

use libloading::Library;

use crate::ffi::*;
use crate::{AvInfo, CoreConfig, Error};

// ---------------------------------------------------------------------------
// Thread-local state shared with C callbacks
// ---------------------------------------------------------------------------

thread_local! {
    /// Whether the core supports running without a game loaded.
    static SUPPORTS_NO_GAME: Cell<bool> = const { Cell::new(false) };

    /// System directory path (for GET_SYSTEM_DIRECTORY env command).
    static SYSTEM_DIR: RefCell<Option<CString>> = const { RefCell::new(None) };

    /// Save directory path (for GET_SAVE_DIRECTORY env command).
    static SAVE_DIR: RefCell<Option<CString>> = const { RefCell::new(None) };

    /// Content path CString — must outlive the retro_load_game call.
    static CONTENT_PATH_CSTR: RefCell<Option<CString>> = const { RefCell::new(None) };

    /// Preloaded ROM data — must outlive the retro_load_game call.
    static CONTENT_DATA: RefCell<Option<Vec<u8>>> = const { RefCell::new(None) };

    /// Frame buffer populated by the video refresh callback.
    static FRAME_BUFFER: RefCell<Vec<u8>> = RefCell::new(Vec::new());

    /// Audio buffer populated by the audio sample batch callback.
    static AUDIO_BUFFER: RefCell<Vec<i16>> = RefCell::new(Vec::new());

    /// Input state bitmask per port.
    static INPUT_STATE: RefCell<[u16; 4]> = RefCell::new([0; 4]);

    /// Pixel format negotiated with the core.
    static PIXEL_FORMAT: Cell<u32> = const { Cell::new(RETRO_PIXEL_FORMAT_XRGB8888) };
}

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

    /// Deinitialization function pointer.
    retro_deinit: RetroDeinit,

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

    /// Whether a game is currently loaded.
    game_loaded: bool,
}

impl Core {
    /// Load a libretro core, initialize it, and optionally load game content.
    ///
    /// If `config.content_path` is `None` and the core declares
    /// `SET_SUPPORT_NO_GAME`, the core is initialized without content
    /// (e.g. the 2048 core). Otherwise, `content_path` is required.
    ///
    /// # Safety
    ///
    /// `config.core_path` must point to a valid libretro shared library.
    /// The core runs native code — this executes `dlopen`, `retro_init()`,
    /// and `retro_load_game()`. The caller must ensure the core is a
    /// trusted libretro implementation.
    pub unsafe fn load(config: CoreConfig) -> Result<Self, Error> {
        // ---- Step 1: dlopen ----
        // SAFETY: caller guarantees the path points to a valid shared library.
        let library = unsafe {
            Library::new(&config.core_path).map_err(|e| Error::Load(e))?
        };

        // ---- Step 2: symbol lookup ----
        // SAFETY: each call looks up a named symbol from the loaded library.
        // The libretro ABI mandates these exact symbol names and signatures.
        // The library is kept alive in `_library` (see struct field order).

        // Required symbols
        let retro_set_environment =
            unsafe { load_symbol::<RetroSetEnvironment>(&library, c"retro_set_environment") }?;
        let retro_set_video_refresh =
            unsafe { load_symbol::<RetroSetVideoRefresh>(&library, c"retro_set_video_refresh") }?;
        let retro_set_audio_sample_batch =
            unsafe { load_symbol::<RetroSetAudioSampleBatch>(&library, c"retro_set_audio_sample_batch") }?;
        let retro_set_input_poll =
            unsafe { load_symbol::<RetroSetInputPoll>(&library, c"retro_set_input_poll") }?;
        let retro_set_input_state =
            unsafe { load_symbol::<RetroSetInputState>(&library, c"retro_set_input_state") }?;
        let retro_init = unsafe { load_symbol::<RetroInit>(&library, c"retro_init") }?;
        let retro_deinit = unsafe { load_symbol::<RetroDeinit>(&library, c"retro_deinit") }?;
        let retro_run = unsafe { load_symbol::<RetroRun>(&library, c"retro_run") }?;
        let retro_load_game =
            unsafe { load_symbol::<RetroLoadGame>(&library, c"retro_load_game") }?;
        let retro_unload_game =
            unsafe { load_symbol::<RetroUnloadGame>(&library, c"retro_unload_game") }?;

        // Optional symbols
        let retro_get_system_info =
            unsafe { load_optional_symbol::<RetroGetSystemInfo>(&library, c"retro_get_system_info") };
        let retro_get_system_av_info =
            unsafe { load_optional_symbol::<RetroGetSystemAvInfo>(&library, c"retro_get_system_av_info") };
        let retro_get_memory_data =
            unsafe { load_optional_symbol::<RetroGetMemoryData>(&library, c"retro_get_memory_data") };
        let retro_get_memory_size =
            unsafe { load_optional_symbol::<RetroGetMemorySize>(&library, c"retro_get_memory_size") };
        let retro_serialize_size =
            unsafe { load_optional_symbol::<RetroSerializeSize>(&library, c"retro_serialize_size") };
        let retro_serialize =
            unsafe { load_optional_symbol::<RetroSerialize>(&library, c"retro_serialize") };
        let retro_unserialize =
            unsafe { load_optional_symbol::<RetroUnserialize>(&library, c"retro_unserialize") };

        // ---- Step 3: stash config for callbacks ----
        SYSTEM_DIR.with(|cell| {
            *cell.borrow_mut() = CString::new(
                config.system_dir.to_string_lossy().as_bytes(),
            ).ok();
        });
        SAVE_DIR.with(|cell| {
            *cell.borrow_mut() = CString::new(
                config.save_dir.to_string_lossy().as_bytes(),
            ).ok();
        });

        // ---- Step 4: register callbacks ----
        // SAFETY: registering function pointers that match the ABI.
        // The C side will call back into our safe Rust wrappers.
        unsafe { retro_set_environment(environment_callback) };
        unsafe { retro_set_video_refresh(stub_video_refresh) };
        unsafe { retro_set_audio_sample_batch(stub_audio_batch) };
        unsafe { retro_set_input_poll(stub_input_poll) };
        unsafe { retro_set_input_state(stub_input_state) };

        // ---- Step 5: retro_init ----
        // SAFETY: callbacks are registered. retro_init must be called once
        // before any other core operations.
        unsafe { retro_init() };

        // ---- Step 6: determine content loading strategy ----
        let need_fullpath = if let Some(get_system_info) = retro_get_system_info {
            let mut info = RetroSystemInfo {
                library_name: ptr::null(),
                library_version: ptr::null(),
                valid_extensions: ptr::null(),
                need_fullpath: false,
                block_extract: false,
            };
            // SAFETY: retro_get_system_info writes into the RetroSystemInfo
            // struct. The function pointer is valid and the library is loaded.
            unsafe { get_system_info(&mut info) };
            info.need_fullpath
        } else {
            false
        };

        let supports_no_game = SUPPORTS_NO_GAME.get();

        let load_result = if let Some(content_path) = &config.content_path {
            load_game_content(need_fullpath, content_path, retro_load_game)
        } else if supports_no_game {
            // Core supports no-game mode — call with null game info
            // SAFETY: retro_load_game with null game info is valid for
            // cores that declare SET_SUPPORT_NO_GAME.
            unsafe { retro_load_game(ptr::null()) };
            true
        } else {
            // SAFETY: clean up — core was init'd but can't proceed.
            unsafe { retro_deinit() };
            return Err(Error::Other(
                "content_path is required for this core (core does not support no-game mode)"
                    .into(),
            ));
        };

        if !load_result {
            // SAFETY: load failed — must deinit.
            unsafe { retro_deinit() };
            return Err(Error::Other("retro_load_game returned false".into()));
        }

        // ---- Step 7: get AV info ----
        let av_info = if let Some(get_system_av_info) = retro_get_system_av_info {
            let mut sys_av: RetroSystemAvInfo = unsafe { std::mem::zeroed() };
            // SAFETY: retro_get_system_av_info writes into the struct.
            // Must be called after retro_load_game succeeds.
            unsafe { get_system_av_info(&mut sys_av) };
            AvInfo {
                base_width: sys_av.geometry.base_width,
                base_height: sys_av.geometry.base_height,
                max_width: sys_av.geometry.max_width,
                max_height: sys_av.geometry.max_height,
                aspect_ratio: sys_av.geometry.aspect_ratio,
                fps: sys_av.timing.fps,
                sample_rate: sys_av.timing.sample_rate,
            }
        } else {
            // Fallback for cores that don't expose av_info
            AvInfo {
                base_width: 320,
                base_height: 240,
                max_width: 320,
                max_height: 240,
                aspect_ratio: 1.0,
                fps: 60.0,
                sample_rate: 48000.0,
            }
        };

        Ok(Core {
            _library: library,
            retro_deinit,
            retro_run,
            retro_load_game,
            retro_unload_game,
            retro_get_memory_data,
            retro_get_memory_size,
            retro_serialize_size,
            retro_serialize,
            retro_unserialize,
            av_info,
            game_loaded: true,
        })
    }
}

impl Drop for Core {
    fn drop(&mut self) {
        if self.game_loaded {
            // SAFETY: retro_unload_game must be called before retro_deinit.
            // The library is still loaded (self._library outlives this).
            unsafe { (self.retro_unload_game)() };
        }
        // SAFETY: retro_deinit is the last call. The function pointers and
        // library are still valid.
        unsafe { (self.retro_deinit)() };
    }
}

// ---------------------------------------------------------------------------
// Environment callback
// ---------------------------------------------------------------------------

/// Environment callback — handles core queries for directories, pixel format,
/// and tracks whether the core supports no-game mode.
unsafe extern "C" fn environment_callback(cmd: u32, data: *mut std::ffi::c_void) -> bool {
    match cmd {
        // Accept only XRGB8888 and RGB565 pixel formats
        RETRO_ENVIRONMENT_SET_PIXEL_FORMAT => {
            if !data.is_null() {
                let fmt = unsafe { *(data as *const u32) };
                if fmt == RETRO_PIXEL_FORMAT_XRGB8888 || fmt == RETRO_PIXEL_FORMAT_RGB565 {
                    PIXEL_FORMAT.set(fmt);
                    return true;
                }
            }
            false
        }

        // Provide system directory path
        RETRO_ENVIRONMENT_GET_SYSTEM_DIRECTORY => {
            if !data.is_null() {
                SYSTEM_DIR.with(|cell| {
                    if let Some(ref dir) = *cell.borrow() {
                        unsafe {
                            *(data as *mut *const std::ffi::c_char) = dir.as_ptr();
                        }
                        return true;
                    }
                    false
                })
            } else {
                false
            }
        }

        // Provide save directory path
        RETRO_ENVIRONMENT_GET_SAVE_DIRECTORY => {
            if !data.is_null() {
                SAVE_DIR.with(|cell| {
                    if let Some(ref dir) = *cell.borrow() {
                        unsafe {
                            *(data as *mut *const std::ffi::c_char) = dir.as_ptr();
                        }
                        return true;
                    }
                    false
                })
            } else {
                false
            }
        }

        // Track that the core supports no-game mode
        RETRO_ENVIRONMENT_SET_SUPPORT_NO_GAME => {
            SUPPORTS_NO_GAME.set(true);
            true
        }

        // For all other commands, return false (core will try fallbacks)
        _ => false,
    }
}

// ---------------------------------------------------------------------------
// Content loading helpers
// ---------------------------------------------------------------------------

/// Load game content into the core, with path-only fallback.
fn load_game_content(
    need_fullpath: bool,
    content_path: &Path,
    retro_load_game: RetroLoadGame,
) -> bool {
    let cpath = CString::new(
        content_path.to_string_lossy().as_bytes(),
    );
    let Ok(cpath) = cpath else {
        return false;
    };

    if need_fullpath {
        // Core needs the real file path — pass path only
        CONTENT_PATH_CSTR.with(|cell| *cell.borrow_mut() = Some(cpath));
        let game_info = RetroGameInfo {
            path: CONTENT_PATH_CSTR.with(|cell| {
                cell.borrow()
                    .as_ref()
                    .map(|cs| cs.as_ptr())
                    .unwrap_or(ptr::null())
            }),
            data: ptr::null(),
            size: 0,
            meta: ptr::null(),
        };
        let result = unsafe { retro_load_game(&game_info) };
        if result {
            return true;
        }
        // Don't fallback — core said it needs fullpath
        return false;
    }

    // Try preloading ROM into memory
    let data = match std::fs::read(content_path) {
        Ok(d) => d,
        Err(_) => {
            // Can't read the file — try path-only as fallback
            CONTENT_PATH_CSTR.with(|cell| *cell.borrow_mut() = Some(cpath));
            let game_info = RetroGameInfo {
                path: CONTENT_PATH_CSTR.with(|cell| {
                    cell.borrow()
                        .as_ref()
                        .map(|cs| cs.as_ptr())
                        .unwrap_or(ptr::null())
                }),
                data: ptr::null(),
                size: 0,
                meta: ptr::null(),
            };
            return unsafe { retro_load_game(&game_info) };
        }
    };

    CONTENT_DATA.with(|cell| *cell.borrow_mut() = Some(data));
    let game_info = RetroGameInfo {
        data: CONTENT_DATA.with(|cell| {
            cell.borrow()
                .as_ref()
                .map(|d| d.as_ptr() as *const std::ffi::c_void)
                .unwrap_or(ptr::null())
        }),
        size: CONTENT_DATA.with(|cell| {
            cell.borrow().as_ref().map(|d| d.len()).unwrap_or(0)
        }),
        path: ptr::null(),
        meta: ptr::null(),
    };

    // SAFETY: game_info fields all point to valid data that outlives the call.
    if unsafe { retro_load_game(&game_info) } {
        return true;
    }

    // In-memory load failed — retry with path-only
    CONTENT_PATH_CSTR.with(|cell| *cell.borrow_mut() = Some(cpath));
    let fallback_info = RetroGameInfo {
        path: CONTENT_PATH_CSTR.with(|cell| {
            cell.borrow()
                .as_ref()
                .map(|cs| cs.as_ptr())
                .unwrap_or(ptr::null())
        }),
        data: ptr::null(),
        size: 0,
        meta: ptr::null(),
    };
    // SAFETY: fallback_info path is a valid CString that outlives the call.
    unsafe { retro_load_game(&fallback_info) }
}

// ---------------------------------------------------------------------------
// Stub callbacks (replaced in Tasks 5-7)
// ---------------------------------------------------------------------------

unsafe extern "C" fn stub_video_refresh(
    _data: *const std::ffi::c_void,
    _width: u32,
    _height: u32,
    _pitch: usize,
) {
}

unsafe extern "C" fn stub_audio_batch(_data: *const i16, _frames: usize) -> usize {
    0
}

unsafe extern "C" fn stub_input_poll() {}

unsafe extern "C" fn stub_input_state(
    _port: u32,
    _device: u32,
    _index: u32,
    _id: u32,
) -> i16 {
    0
}
