//! Core loading and lifecycle.
//!
//! Handles dlopen, symbol lookup, callback registration, retro_init,
//! content loading, AV info extraction, and the frame run loop.

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

    /// Raw frame buffer populated by the video refresh callback.
    static RAW_FRAME: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };

    /// Most recent frame dimensions from the callback: (width, height, pitch_bytes).
    static RAW_FRAME_DIMS: RefCell<(u32, u32, usize)> = const { RefCell::new((0, 0, 0)) };

    /// Audio buffer populated by the audio sample batch callback.
    static AUDIO_BUFFER: RefCell<Vec<i16>> = const { RefCell::new(Vec::new()) };
    /// Input state bitmask per port.
    static INPUT_STATE: RefCell<[u16; 4]> = const { RefCell::new([0; 4]) };

    /// Pixel format currently used for frame conversion.
    ///
    /// Libretro's ABI default is 0RGB1555. Cores only change this by
    /// calling RETRO_ENVIRONMENT_SET_PIXEL_FORMAT during/after init.
    static PIXEL_FORMAT: Cell<u32> = const { Cell::new(RETRO_PIXEL_FORMAT_0RGB1555) };
    /// Whether the core explicitly called SET_PIXEL_FORMAT this load.
    static PIXEL_FORMAT_NEGOTIATED: Cell<bool> = const { Cell::new(false) };
    /// Number of audio channels the core outputs (1 = mono, 2 = stereo).
    static AUDIO_CHANNELS: Cell<u16> = const { Cell::new(2) };

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
            .map_err(Error::Load)
            .map(|sym| *sym)
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
    #[allow(dead_code)]
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

    /// Converted RGB24 frame from the most recent run_frame().
    current_frame: Vec<u8>,

    /// Dimensions of the current frame (width, height).
    current_frame_dims: (u32, u32),

    /// Pixel format carried with the Core across threads.
    pixel_format: u32,
    /// Whether the core explicitly negotiated the pixel format.
    pixel_format_negotiated: bool,
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
        let library = unsafe { Library::new(&config.core_path).map_err(Error::Load)? };

        // ---- Step 2: symbol lookup ----
        // SAFETY: each call looks up a named symbol from the loaded library.
        // The libretro ABI mandates these exact symbol names and signatures.
        // The library is kept alive in `_library` (see struct field order).

        // Required symbols
        let retro_set_environment =
            unsafe { load_symbol::<RetroSetEnvironment>(&library, c"retro_set_environment") }?;
        let retro_set_video_refresh =
            unsafe { load_symbol::<RetroSetVideoRefresh>(&library, c"retro_set_video_refresh") }?;
        let retro_set_audio_sample_batch = unsafe {
            load_symbol::<RetroSetAudioSampleBatch>(&library, c"retro_set_audio_sample_batch")
        }?;
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
        let retro_get_system_info = unsafe {
            load_optional_symbol::<RetroGetSystemInfo>(&library, c"retro_get_system_info")
        };
        let retro_get_system_av_info = unsafe {
            load_optional_symbol::<RetroGetSystemAvInfo>(&library, c"retro_get_system_av_info")
        };
        let retro_get_memory_data = unsafe {
            load_optional_symbol::<RetroGetMemoryData>(&library, c"retro_get_memory_data")
        };
        let retro_get_memory_size = unsafe {
            load_optional_symbol::<RetroGetMemorySize>(&library, c"retro_get_memory_size")
        };
        let retro_serialize_size = unsafe {
            load_optional_symbol::<RetroSerializeSize>(&library, c"retro_serialize_size")
        };
        let retro_serialize =
            unsafe { load_optional_symbol::<RetroSerialize>(&library, c"retro_serialize") };
        let retro_unserialize =
            unsafe { load_optional_symbol::<RetroUnserialize>(&library, c"retro_unserialize") };
        let retro_set_controller_port_device = unsafe {
            load_optional_symbol::<RetroSetControllerPortDevice>(
                &library,
                c"retro_set_controller_port_device",
            )
        };
        let retro_set_audio_sample = unsafe {
            load_optional_symbol::<RetroSetAudioSample>(&library, c"retro_set_audio_sample")
        };

        // ---- Step 3: reset thread-local core state and stash config for callbacks ----
        // These are process/thread globals used by the C callbacks. A worker may
        // load NES, SNES, and Genesis cores sequentially on the same thread; do
        // not let the previous core's negotiated pixel format or frame buffer
        // bleed into the next core. Per libretro.h, if a core does not call
        // SET_PIXEL_FORMAT, the frame data is 0RGB1555.
        PIXEL_FORMAT.with(|f| f.set(RETRO_PIXEL_FORMAT_0RGB1555));
        PIXEL_FORMAT_NEGOTIATED.with(|f| f.set(false));
        SUPPORTS_NO_GAME.set(false);
        RAW_FRAME.with(|buf| buf.borrow_mut().clear());
        RAW_FRAME_DIMS.with(|dims| *dims.borrow_mut() = (0, 0, 0));
        AUDIO_BUFFER.with(|buf| buf.borrow_mut().clear());
        INPUT_STATE.with(|state| *state.borrow_mut() = [0; 4]);

        SYSTEM_DIR.with(|cell| {
            *cell.borrow_mut() = CString::new(config.system_dir.to_string_lossy().as_bytes()).ok();
        });
        SAVE_DIR.with(|cell| {
            *cell.borrow_mut() = CString::new(config.save_dir.to_string_lossy().as_bytes()).ok();
        });
        AUDIO_CHANNELS.with(|c| c.set(config.audio_channels));

        // ---- Step 4: register callbacks ----
        // SAFETY: registering function pointers that match the ABI.
        // The C side will call back into our safe Rust wrappers.
        unsafe { retro_set_environment(environment_callback) };
        unsafe { retro_set_video_refresh(video_refresh_callback) };
        unsafe { retro_set_audio_sample_batch(audio_batch_callback) };
        if let Some(set_sample) = retro_set_audio_sample {
            unsafe { set_sample(audio_sample_callback) };
            tracing::info!("[CORE] Registered per-sample audio callback");
        }
        unsafe { retro_set_input_poll(stub_input_poll) };
        unsafe { retro_set_input_state(input_state_callback) };

        // ---- Step 5: retro_init ----
        // SAFETY: callbacks are registered. retro_init must be called once
        // before any other core operations.
        unsafe { retro_init() };

        // ---- Set controller ports to joypad ----
        // Without this, most cores default to RETRO_DEVICE_NONE and ignore
        // all input. Set all 4 ports to standard joypad.
        if let Some(set_controller) = retro_set_controller_port_device {
            for port in 0..4u32 {
                unsafe { set_controller(port, RETRO_DEVICE_JOYPAD) };
            }
            tracing::info!("[CORE] Controller ports 0-3 set to RETRO_DEVICE_JOYPAD");
        } else {
            tracing::warn!("[CORE] retro_set_controller_port_device not available in this core");
        }

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

        let pixel_format = PIXEL_FORMAT.with(|f| f.get());
        let pixel_format_negotiated = PIXEL_FORMAT_NEGOTIATED.with(|f| f.get());

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
            current_frame: Vec::new(),
            current_frame_dims: (0, 0),
            pixel_format,
            pixel_format_negotiated,
        })
    }

    /// Run a single frame — calls `retro_run()` and captures video output.
    ///
    /// After this call, read the frame with [`frame()`](Self::frame) and
    /// audio with [`audio()`](Self::audio).
    ///
    /// # Safety
    ///
    /// The core must be loaded and initialized. Callbacks are invoked
    /// synchronously within this call.
    pub fn run_frame(&mut self) -> Result<(), Error> {
        // Clear audio accumulation (will be populated by the callback)
        AUDIO_BUFFER.with(|buf| buf.borrow_mut().clear());

        // SAFETY: retro_run is a valid function pointer. The library is loaded
        // and callbacks are registered. The core will call our video/audio/input
        // callbacks synchronously.
        unsafe { (self.retro_run)() };

        // If a core negotiates or changes pixel format during retro_run(), that
        // callback runs on this same core thread. Initial negotiation often
        // happens during Core::load() on the caller thread, so do not overwrite
        // the carried format with this thread's default unless a negotiation
        // actually happened here.
        if PIXEL_FORMAT_NEGOTIATED.with(|f| f.get()) {
            self.pixel_format = PIXEL_FORMAT.with(|f| f.get());
            self.pixel_format_negotiated = true;
        }

        // Convert captured raw frame to RGB24
        self.convert_and_store_frame();

        Ok(())
    }

    /// Returns the most recent frame as RGB24 bytes, or `None` if no frame
    /// has been captured yet.
    pub fn frame(&self) -> Option<&[u8]> {
        if self.current_frame.is_empty() {
            None
        } else {
            Some(&self.current_frame)
        }
    }

    /// Returns the dimensions of the most recent frame (width, height).
    pub fn frame_size(&self) -> (u32, u32) {
        self.current_frame_dims
    }

    /// Returns accumulated audio samples since the last `run_frame()`.
    ///
    /// Returns an empty vec for cores without audio (e.g. 2048).
    /// The caller feeds these samples to an audio encoder.
    pub fn audio(&self) -> Vec<i16> {
        AUDIO_BUFFER.with(|buf| buf.borrow().clone())
    }

    /// Drain accumulated audio samples, clearing the internal buffer.
    /// Returns interleaved stereo i16 PCM samples.
    pub fn drain_audio(&self) -> Vec<i16> {
        AUDIO_BUFFER.with(|buf| {
            let mut buf = buf.borrow_mut();
            let samples = buf.clone();
            buf.clear();
            samples
        })
    }

    /// Set a joypad button state for a given port.
    ///
    /// `port` is 0-indexed (0–3). Call this before `run_frame()` — the
    /// core reads input state during `retro_run()` via the input callback.
    pub fn set_joypad(&mut self, port: u32, button: crate::JoypadButton, pressed: bool) {
        let mask = 1u16 << (button as u8);
        INPUT_STATE.with(|state| {
            let mut state = state.borrow_mut();
            let idx = port as usize;
            if idx < state.len() {
                if pressed {
                    state[idx] |= mask;
                } else {
                    state[idx] &= !mask;
                }
            }
        });
    }

    /// Set the full 16-bit joypad bitmask for a given port.
    ///
    /// `port` is 0-indexed (0–3). The bitmask uses the RetroArch layout
    /// (B=0, Y=1, Select=2, Start=3, Up=4, Down=5, …). Call this before
    /// `run_frame()`.
    pub fn set_input(&mut self, port: u32, state: u16) {
        INPUT_STATE.with(|s| {
            let mut s = s.borrow_mut();
            let idx = port as usize;
            if idx < s.len() {
                s[idx] = state;
            }
        });
    }

    /// Read the current joypad state for a port (for testing).
    pub fn joypad_state(&self, port: u32) -> u16 {
        INPUT_STATE.with(|s| {
            let s = s.borrow();
            let idx = port as usize;
            if idx < s.len() { s[idx] } else { 0 }
        })
    }

    // -----------------------------------------------------------------------
    // Save states
    // -----------------------------------------------------------------------

    /// Whether the core supports save states via `retro_serialize`.
    pub fn can_save_state(&self) -> bool {
        self.retro_serialize.is_some()
    }

    /// Serialize the current emulator state.
    ///
    /// Returns `None` if the core does not support serialization or the
    /// state size is 0. The returned bytes are opaque — do not parse them.
    /// May block for tens of milliseconds on large cores (e.g. N64: 8+ MB).
    pub fn save_state(&self) -> Option<Vec<u8>> {
        let serialize = self.retro_serialize?;
        let serialize_size = self.retro_serialize_size?;

        // SAFETY: the function pointer is valid and the library is loaded.
        let size = unsafe { serialize_size() };
        if size == 0 {
            return None;
        }

        let mut buf = vec![0u8; size];
        // SAFETY: the buffer is large enough. The core writes `size` bytes.
        let ok = unsafe { serialize(buf.as_mut_ptr() as *mut std::ffi::c_void, size) };
        if ok { Some(buf) } else { None }
    }

    /// Deserialize a previously-saved emulator state.
    ///
    /// Returns `false` if the core does not support deserialization or
    /// the operation fails (e.g. corrupted or incompatible state data).
    pub fn load_state(&mut self, data: &[u8]) -> bool {
        let unserialize = match self.retro_unserialize {
            Some(f) => f,
            None => return false,
        };

        if data.is_empty() {
            return false;
        }

        // SAFETY: the function pointer is valid and the library is loaded.
        unsafe { unserialize(data.as_ptr() as *const std::ffi::c_void, data.len()) }
    }

    // -----------------------------------------------------------------------
    // SRAM (battery-backed save RAM)
    // -----------------------------------------------------------------------

    /// Whether the core supports SRAM access.
    pub fn can_sram(&self) -> bool {
        self.retro_get_memory_data.is_some() && self.retro_get_memory_size.is_some()
    }

    /// Copy battery-backed save RAM from the core's internal buffer.
    ///
    /// Returns `None` if the core does not support SRAM or has 0 bytes.
    /// **Call this BEFORE `unload_game()`** — the pointer becomes invalid
    /// after the game is unloaded.
    pub fn sram(&self) -> Option<Vec<u8>> {
        let get_data = self.retro_get_memory_data?;
        let get_size = self.retro_get_memory_size?;

        // SAFETY: the function pointers are valid and the library is loaded.
        let size = unsafe { get_size(RETRO_MEMORY_SAVE_RAM) };
        if size == 0 {
            return None;
        }

        // SAFETY: the returned pointer is valid for `size` bytes. We must
        // copy immediately — the core may free or reuse this buffer.
        let ptr = unsafe { get_data(RETRO_MEMORY_SAVE_RAM) };
        if ptr.is_null() {
            return None;
        }

        let mut buf = vec![0u8; size];
        // SAFETY: ptr is valid for `size` bytes as guaranteed by the core.
        unsafe {
            std::ptr::copy_nonoverlapping(ptr as *const u8, buf.as_mut_ptr(), size);
        }
        Some(buf)
    }

    /// Restore battery-backed save RAM into the core.
    ///
    /// Call this AFTER `retro_load_game()` but BEFORE the first
    /// `retro_run()`. Truncates to `min(data.len(), core SRAM size)`.
    pub fn restore_sram(&self, data: &[u8]) {
        let Some(get_data) = self.retro_get_memory_data else {
            return;
        };
        let Some(get_size) = self.retro_get_memory_size else {
            return;
        };

        // SAFETY: the function pointers are valid and the library is loaded.
        let size = unsafe { get_size(RETRO_MEMORY_SAVE_RAM) };
        if size == 0 {
            return;
        }

        let ptr = unsafe { get_data(RETRO_MEMORY_SAVE_RAM) };
        if ptr.is_null() {
            return;
        }

        let copy_len = data.len().min(size);
        // SAFETY: ptr is valid for `size` bytes; we copy at most `size`
        // bytes from `data`, which has length `copy_len`.
        unsafe {
            std::ptr::copy_nonoverlapping(data.as_ptr(), ptr as *mut u8, copy_len);
        }
    }

    /// Convert the raw frame in thread-local storage to RGB24 and store on self.
    fn convert_and_store_frame(&mut self) {
        let fmt = self.pixel_format;
        let fmt_negotiated = self.pixel_format_negotiated;
        let ((w, h, pitch), raw) = RAW_FRAME_DIMS.with(|d| {
            let dims = *d.borrow();
            // Copy raw frame out of thread-local to avoid borrow conflicts
            let raw = RAW_FRAME.with(|buf| buf.borrow().clone());
            (dims, raw)
        });

        if w == 0 || h == 0 || raw.is_empty() {
            // No frame this tick — keep previous
            return;
        }

        // ── Infer missing pixel-format negotiation from pitch ──
        // Libretro's ABI default is 0RGB1555, but several software cores that
        // do not call SET_PIXEL_FORMAT still pass 32-bit XRGB8888 frames.
        // Stride/pitch is the reliable boundary evidence: if the core did not
        // negotiate a format and each row is exactly width*4 bytes, decode as
        // XRGB8888; if each row is width*2 bytes, keep the ABI default 0RGB1555.
        // Explicit SET_PIXEL_FORMAT always wins.
        let effective_fmt = {
            let row_pixels = w as usize;
            if !fmt_negotiated && fmt == RETRO_PIXEL_FORMAT_0RGB1555 {
                if pitch == row_pixels * 4 {
                    tracing::info!(
                        "[CORE] Inferred XRGB8888 from pitch ({} bytes/row for {}×{}, no SET_PIXEL_FORMAT)",
                        pitch,
                        w,
                        h
                    );
                    RETRO_PIXEL_FORMAT_XRGB8888
                } else if pitch == row_pixels * 2 {
                    RETRO_PIXEL_FORMAT_0RGB1555
                } else {
                    tracing::warn!(
                        "[CORE] Ambiguous no-negotiation frame pitch: {} bytes/row for {}×{}; using libretro default 0RGB1555",
                        pitch,
                        w,
                        h
                    );
                    RETRO_PIXEL_FORMAT_0RGB1555
                }
            } else {
                fmt
            }
        };

        let bpp = match effective_fmt {
            RETRO_PIXEL_FORMAT_XRGB8888 => 4usize,
            RETRO_PIXEL_FORMAT_RGB565 => 2,
            RETRO_PIXEL_FORMAT_0RGB1555 => 2,
            _ => 0,
        };
        let expected_row_bytes = w as usize * bpp;
        let has_padding = pitch != expected_row_bytes;

        // Log first frame and any dimension/format/pitch change
        if self.current_frame.is_empty() || self.current_frame_dims != (w, h) || has_padding {
            tracing::info!(
                "[CORE] Frame: {}×{} pitch={} fmt={} (expected row bytes={}, padding={})",
                w,
                h,
                pitch,
                effective_fmt,
                expected_row_bytes,
                has_padding
            );
        }

        self.current_frame_dims = (w, h);

        match effective_fmt {
            RETRO_PIXEL_FORMAT_XRGB8888 => {
                if has_padding {
                    self.current_frame =
                        xrgb8888_to_rgb24_strided(&raw, w as usize, h as usize, pitch);
                } else {
                    self.current_frame = xrgb8888_to_rgb24(&raw, w as usize, h as usize);
                }
            }
            RETRO_PIXEL_FORMAT_RGB565 => {
                if has_padding {
                    self.current_frame =
                        rgb565_to_rgb24_strided(&raw, w as usize, h as usize, pitch);
                } else {
                    self.current_frame = rgb565_to_rgb24(&raw, w as usize, h as usize);
                }
            }
            RETRO_PIXEL_FORMAT_0RGB1555 => {
                if has_padding {
                    self.current_frame =
                        xrgb1555_to_rgb24_strided(&raw, w as usize, h as usize, pitch);
                } else {
                    self.current_frame = xrgb1555_to_rgb24(&raw, w as usize, h as usize);
                }
            }
            _ => {
                // Unknown format — store raw as-is (caller beware)
                tracing::warn!(
                    "[CORE] Unknown pixel format {} — storing raw frame ({})",
                    effective_fmt,
                    raw.len()
                );
                self.current_frame = raw;
            }
        }
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
        // Accept XRGB8888, RGB565, and 0RGB1555 pixel formats
        RETRO_ENVIRONMENT_SET_PIXEL_FORMAT => {
            if !data.is_null() {
                let fmt = unsafe { *(data as *const u32) };
                let name = match fmt {
                    RETRO_PIXEL_FORMAT_XRGB8888 => "XRGB8888",
                    RETRO_PIXEL_FORMAT_RGB565 => "RGB565",
                    RETRO_PIXEL_FORMAT_0RGB1555 => "0RGB1555",
                    _ => "unknown",
                };
                if fmt == RETRO_PIXEL_FORMAT_XRGB8888
                    || fmt == RETRO_PIXEL_FORMAT_RGB565
                    || fmt == RETRO_PIXEL_FORMAT_0RGB1555
                {
                    tracing::info!("[CORE] SET_PIXEL_FORMAT: {} ({}) — accepted", name, fmt);
                    PIXEL_FORMAT.set(fmt);
                    PIXEL_FORMAT_NEGOTIATED.with(|negotiated| negotiated.set(true));
                    return true;
                }
                tracing::warn!("[CORE] SET_PIXEL_FORMAT: {} ({}) — REJECTED", name, fmt);
            }
            false
        }

        // Provide system directory path
        RETRO_ENVIRONMENT_GET_SYSTEM_DIRECTORY if !data.is_null() => SYSTEM_DIR.with(|cell| {
            if let Some(ref dir) = *cell.borrow() {
                unsafe {
                    *(data as *mut *const std::ffi::c_char) = dir.as_ptr();
                }
                return true;
            }
            false
        }),

        // Provide save directory path
        RETRO_ENVIRONMENT_GET_SAVE_DIRECTORY if !data.is_null() => SAVE_DIR.with(|cell| {
            if let Some(ref dir) = *cell.borrow() {
                unsafe {
                    *(data as *mut *const std::ffi::c_char) = dir.as_ptr();
                }
                return true;
            }
            false
        }),

        // Track that the core supports no-game mode
        RETRO_ENVIRONMENT_SET_SUPPORT_NO_GAME => {
            SUPPORTS_NO_GAME.set(true);
            true
        }

        // For all other commands, return false (core will try fallbacks)
        _ => {
            tracing::debug!("[CORE] unhandled env cmd: {} (0x{:x})", cmd, cmd);
            false
        }
    }
}

// ---------------------------------------------------------------------------
// Video callback
// ---------------------------------------------------------------------------

/// Video refresh callback — called by the core each frame with rendered pixels.
///
/// `data` is null for duplicate frames or HW-rendered cores. In that case we
/// keep the previous frame buffer.
unsafe extern "C" fn video_refresh_callback(
    data: *const std::ffi::c_void,
    width: u32,
    height: u32,
    pitch: usize,
) {
    if data.is_null() {
        // Duplicate frame — keep previous raw frame buffer
        return;
    }

    if width == 0 || height == 0 {
        return;
    }

    let byte_count = pitch * height as usize;

    RAW_FRAME_DIMS.with(|dims| {
        *dims.borrow_mut() = (width, height, pitch);
    });

    RAW_FRAME.with(|buf| {
        let mut buf = buf.borrow_mut();
        buf.resize(byte_count, 0);
        // SAFETY: data is a valid pointer from the core. The core guarantees
        // it points to at least `byte_count` bytes of pixel data.
        unsafe {
            ptr::copy_nonoverlapping(data as *const u8, buf.as_mut_ptr(), byte_count);
        }
    });
}

// ---------------------------------------------------------------------------
// Pixel format conversion
// ---------------------------------------------------------------------------

/// Convert XRGB8888 to RGB24 by dropping the alpha byte from each pixel.
fn xrgb8888_to_rgb24(data: &[u8], width: usize, height: usize) -> Vec<u8> {
    let pixel_count = width * height;
    let expected_bytes = pixel_count * 4;
    if data.len() < expected_bytes {
        return Vec::new();
    }

    let mut rgb = Vec::with_capacity(pixel_count * 3);
    // SAFETY: bytemuck cast from &[u8] to &[u32] is safe — u32 has no
    // alignment requirement on x86_64, and we've verified the byte length.
    let pixels: &[u32] = bytemuck::cast_slice(&data[..expected_bytes]);

    for &p in pixels {
        // XRGB8888 layout: 0xXXRRGGBB (little-endian: B, G, R, X in memory)
        rgb.push((p >> 16) as u8); // R
        rgb.push((p >> 8) as u8); // G
        rgb.push(p as u8); // B
    }

    rgb
}

/// Convert RGB565 to RGB24 by unpacking 5-6-5 bit fields into 8-8-8.
fn rgb565_to_rgb24(data: &[u8], width: usize, height: usize) -> Vec<u8> {
    let pixel_count = width * height;
    let expected_bytes = pixel_count * 2;
    if data.len() < expected_bytes {
        return Vec::new();
    }

    let mut rgb = Vec::with_capacity(pixel_count * 3);
    let pixels: &[u16] = bytemuck::cast_slice(&data[..expected_bytes]);

    for &p in pixels {
        // RGB565 layout: RRRRRGGGGGGBBBBB (big-endian 16-bit)
        let r = ((p >> 11) & 0x1F) as u8;
        let g = ((p >> 5) & 0x3F) as u8;
        let b = (p & 0x1F) as u8;

        // Scale 5-bit to 8-bit: (x << 3) | (x >> 2)
        // Scale 6-bit to 8-bit: (x << 2) | (x >> 4)
        rgb.push((r << 3) | (r >> 2));
        rgb.push((g << 2) | (g >> 4));
        rgb.push((b << 3) | (b >> 2));
    }

    rgb
}

/// Convert XRGB8888 to RGB24 with proper stride handling.
///
/// `pitch` is the distance in bytes from start of one row to the next.
/// When pitch > width * 4, padding bytes between rows are skipped.
fn xrgb8888_to_rgb24_strided(data: &[u8], width: usize, height: usize, pitch: usize) -> Vec<u8> {
    let row_bytes = width * 4;
    let expected_total = pitch * height;
    if data.len() < expected_total {
        return Vec::new();
    }

    let mut rgb = Vec::with_capacity(width * height * 3);
    for row in 0..height {
        let row_start = row * pitch;
        let row_data = &data[row_start..row_start + row_bytes];
        let pixels: &[u32] = bytemuck::cast_slice(row_data);
        for &p in pixels {
            rgb.push((p >> 16) as u8); // R
            rgb.push((p >> 8) as u8); // G
            rgb.push(p as u8); // B
        }
    }
    rgb
}

/// Convert RGB565 to RGB24 with proper stride handling.
///
/// `pitch` is the distance in bytes from start of one row to the next.
/// When pitch > width * 2, padding bytes between rows are skipped.
fn rgb565_to_rgb24_strided(data: &[u8], width: usize, height: usize, pitch: usize) -> Vec<u8> {
    let row_bytes = width * 2;
    let expected_total = pitch * height;
    if data.len() < expected_total {
        return Vec::new();
    }

    let mut rgb = Vec::with_capacity(width * height * 3);
    for row in 0..height {
        let row_start = row * pitch;
        let row_data = &data[row_start..row_start + row_bytes];
        let pixels: &[u16] = bytemuck::cast_slice(row_data);
        for &p in pixels {
            let r = ((p >> 11) & 0x1F) as u8;
            let g = ((p >> 5) & 0x3F) as u8;
            let b = (p & 0x1F) as u8;
            rgb.push((r << 3) | (r >> 2));
            rgb.push((g << 2) | (g >> 4));
            rgb.push((b << 3) | (b >> 2));
        }
    }
    rgb
}

/// Convert 0RGB1555 to RGB24 by unpacking 5-5-5 bit fields into 8-8-8.
///
/// 0RGB1555 layout (little-endian u16): bit 15=0(unused), bits 14-10=R,
/// bits 9-5=G, bits 4-0=B. Same as RGB565 but green is 5-bit instead of 6-bit.
fn xrgb1555_to_rgb24(data: &[u8], width: usize, height: usize) -> Vec<u8> {
    let pixel_count = width * height;
    let expected_bytes = pixel_count * 2;
    if data.len() < expected_bytes {
        return Vec::new();
    }

    let mut rgb = Vec::with_capacity(pixel_count * 3);
    let pixels: &[u16] = bytemuck::cast_slice(&data[..expected_bytes]);

    for &p in pixels {
        let r = ((p >> 10) & 0x1F) as u8;
        let g = ((p >> 5) & 0x1F) as u8;
        let b = (p & 0x1F) as u8;
        // Scale 5-bit to 8-bit: (x << 3) | (x >> 2)
        rgb.push((r << 3) | (r >> 2));
        rgb.push((g << 3) | (g >> 2));
        rgb.push((b << 3) | (b >> 2));
    }

    rgb
}

/// Convert 0RGB1555 to RGB24 with proper stride handling.
fn xrgb1555_to_rgb24_strided(data: &[u8], width: usize, height: usize, pitch: usize) -> Vec<u8> {
    let row_bytes = width * 2;
    let expected_total = pitch * height;
    if data.len() < expected_total {
        return Vec::new();
    }

    let mut rgb = Vec::with_capacity(width * height * 3);
    for row in 0..height {
        let row_start = row * pitch;
        let row_data = &data[row_start..row_start + row_bytes];
        let pixels: &[u16] = bytemuck::cast_slice(row_data);
        for &p in pixels {
            let r = ((p >> 10) & 0x1F) as u8;
            let g = ((p >> 5) & 0x1F) as u8;
            let b = (p & 0x1F) as u8;
            rgb.push((r << 3) | (r >> 2));
            rgb.push((g << 3) | (g >> 2));
            rgb.push((b << 3) | (b >> 2));
        }
    }
    rgb
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
    let cpath = CString::new(content_path.to_string_lossy().as_bytes());
    let Ok(cpath) = cpath else {
        tracing::warn!(
            "[CORE] failed to create CString for path: {}",
            content_path.display()
        );
        return false;
    };

    tracing::info!(
        "[CORE] load_game_content: path={} need_fullpath={need_fullpath}",
        content_path.display()
    );

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
        tracing::info!("[CORE] retro_load_game (fullpath) returned {result}");
        if result {
            return true;
        }
        // Don't fallback — core said it needs fullpath
        return false;
    }

    // Try preloading ROM into memory
    let data = match std::fs::read(content_path) {
        Ok(d) => {
            tracing::info!("[CORE] read ROM: {} bytes", d.len());
            d
        }
        Err(e) => {
            tracing::warn!("[CORE] failed to read ROM: {e} — trying path-only fallback");
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
        size: CONTENT_DATA.with(|cell| cell.borrow().as_ref().map(|d| d.len()).unwrap_or(0)),
        path: ptr::null(),
        meta: ptr::null(),
    };

    tracing::info!(
        "[CORE] calling retro_load_game: data={:p} size={}",
        game_info.data,
        game_info.size
    );

    // SAFETY: game_info fields all point to valid data that outlives the call.
    if unsafe { retro_load_game(&game_info) } {
        return true;
    }

    tracing::warn!("[CORE] retro_load_game (in-memory) returned false, trying path-only fallback");

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
// Audio callback
// ---------------------------------------------------------------------------

/// Audio sample callback — called by the core with a single stereo sample pair.
/// Accumulates into the same thread-local buffer as the batch callback.
///
/// Some cores (e.g. nestopia) use this instead of the batch callback.
unsafe extern "C" fn audio_sample_callback(left: i16, right: i16) {
    AUDIO_BUFFER.with(|buf| {
        let mut buf = buf.borrow_mut();
        buf.push(left);
        buf.push(right);
    });
}

/// Audio sample batch callback — called by the core with interleaved stereo
/// i16 PCM samples. Accumulates into the thread-local audio buffer.
///
/// Returns the number of frames consumed (always `frames` — we accept all).
unsafe extern "C" fn audio_batch_callback(data: *const i16, frames: usize) -> usize {
    if data.is_null() || frames == 0 {
        return 0;
    }
    let channels = AUDIO_CHANNELS.with(|c| c.get()) as usize;
    let sample_count = frames * channels;
    AUDIO_BUFFER.with(|buf| {
        let mut buf = buf.borrow_mut();
        let offset = buf.len();
        buf.resize(offset + sample_count, 0);
        // SAFETY: data is a valid pointer from the core. The core guarantees
        // it points to at least `sample_count` i16 values.
        unsafe {
            std::ptr::copy_nonoverlapping(data, buf.as_mut_ptr().add(offset), sample_count);
        }
    });
    frames
}

// ---------------------------------------------------------------------------
// Input callback
// ---------------------------------------------------------------------------

/// Input state callback — called by the core to read button/axis state.
///
/// Returns 0x7FFF for pressed (joypad), -32767..32767 for analog,
/// or 0 for unpressed.
unsafe extern "C" fn input_state_callback(port: u32, device: u32, _index: u32, id: u32) -> i16 {
    if device == RETRO_DEVICE_JOYPAD {
        INPUT_STATE.with(|state| {
            let state = state.borrow();
            let idx = port as usize;
            if idx >= state.len() {
                return 0;
            }
            if id == RETRO_DEVICE_ID_JOYPAD_MASK {
                // Return the full 16-bit button mask
                state[idx] as i16
            } else {
                let mask = 1u16 << id;
                if state[idx] & mask != 0 { 0x7FFF } else { 0 }
            }
        })
    } else {
        // Analog and other devices not yet implemented
        0
    }
}

// ---------------------------------------------------------------------------
// Remaining stub callbacks
// ---------------------------------------------------------------------------

unsafe extern "C" fn stub_input_poll() {}
