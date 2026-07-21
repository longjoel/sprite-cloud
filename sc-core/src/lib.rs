//! Shared-memory IPC between sc-server and sc-core child process.
//!
//! Two mmap'd files in /dev/shm:
//!   sc-out-<game_id>  — core writes frames, server reads
//!   sc-in-<game_id>   — server writes commands, core reads
//!
//! Protocol is single-buffer with atomic flags. No ring, no queue.
//! Core writes a frame and sets `frame_ready`. Server reads and clears.
//! Server writes a command and sets `cmd_ready`. Core reads and clears.

use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU16, AtomicU8};

// ── Constants ────────────────────────────────────────────────────────

/// Max core framebuffer: 512×480 RGB24 = ~720KB. Covers up to PSX/N64.
const MAX_WIDTH: usize = 640;
const MAX_HEIGHT: usize = 480;
/// Max pixels in output buffer (RGB24 bytes).
pub const MAX_PIXELS: usize = MAX_WIDTH * MAX_HEIGHT * 3;
/// Max audio samples in output buffer (stereo i16).
/// 16384 samples = ~170ms at 48kHz stereo, covers high-rate cores without truncation.
pub const MAX_AUDIO: usize = 16384;
/// Max response data size (for save states).
pub const MAX_RESPONSE: usize = 256 * 1024; // 256KB

// ── Output: core → server (frame data) ───────────────────────────────

#[repr(C)]
pub struct OutputShm {
    /// Core sets true when a new frame is available.
    pub frame_ready: AtomicBool,
    /// Sentinel: core sets width=0 on exit/crash.
    pub width: AtomicU32,
    pub height: AtomicU32,
    pub base_width: AtomicU32,
    pub base_height: AtomicU32,
    /// FPS × 1000 (e.g. 60000 for 60fps).
    pub fps_x1000: AtomicU32,
    pub sample_rate: AtomicU32,
    pub pixels: [u8; MAX_PIXELS],
    pub audio: [i16; MAX_AUDIO],
    pub audio_len: AtomicU32,
    /// Response to the last command (save_state data, etc.)
    pub response_ok: AtomicBool,
    pub response_data_len: AtomicU32,
    pub response_data: [u8; MAX_RESPONSE],
    _pad: [u8; 64], // padding to page boundary
}

// Safety: the struct is plain data, shared across processes via mmap.
unsafe impl Send for OutputShm {}
unsafe impl Sync for OutputShm {}

impl OutputShm {
    pub fn size() -> usize {
        std::mem::size_of::<Self>()
    }
}

// ── Input: server → core (commands) ──────────────────────────────────

#[repr(C)]
pub struct InputShm {
    /// Server sets true when a command is available.
    pub cmd_ready: AtomicBool,
    /// 0=none, 1=set_input, 2=save_state, 3=load_state, 4=reset
    pub cmd_type: AtomicU8,
    /// For set_input: controller port (0=P1, 1=P2, ...)
    pub port: AtomicU32,
    /// For set_input: 16-bit RetroArch joypad state
    pub state: AtomicU16,
    /// For save_state/load_state: slot number (1-9)
    pub slot: AtomicU8,
    _pad: [u8; 64],
}

unsafe impl Send for InputShm {}
unsafe impl Sync for InputShm {}

impl InputShm {
    pub fn size() -> usize {
        std::mem::size_of::<Self>()
    }
}

// ── Command types ────────────────────────────────────────────────────

pub const CMD_NONE: u8 = 0;
pub const CMD_SET_INPUT: u8 = 1;
pub const CMD_SAVE_STATE: u8 = 2;
pub const CMD_LOAD_STATE: u8 = 3;
pub const CMD_RESET: u8 = 4;
pub const CMD_SAVE_SRAM: u8 = 5;
pub const CMD_LOAD_SRAM: u8 = 6;

// ── Mmap helpers ─────────────────────────────────────────────────────

/// Open or create a shared memory file in /dev/shm and mmap it.
/// Name should be unique per game session (e.g. "sc-out-<game_id>").
pub fn map_shm<T>(name: &str, size: usize) -> Result<memmap2::MmapMut, String> {
    let path = std::path::Path::new("/dev/shm").join(name);
    
    // Create file if it doesn't exist
    let file = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(true)
        .open(&path)
        .map_err(|e| format!("shm create {}: {e}", path.display()))?;
    
    file.set_len(size as u64)
        .map_err(|e| format!("shm set_len {}: {e}", path.display()))?;
    
    let mmap = unsafe {
        memmap2::MmapMut::map_mut(&file)
    }.map_err(|e| format!("shm mmap {}: {e}", path.display()))?;
    
    Ok(mmap)
}

/// Remove a shared memory file.
pub fn unlink_shm(name: &str) {
    let path = std::path::Path::new("/dev/shm").join(name);
    let _ = std::fs::remove_file(&path);
}
