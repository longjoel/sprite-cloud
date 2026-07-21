//! Save file persistence — ROM hashing, directory layout, atomic writes.
//!
//! Every ROM gets a stable directory under `GV_SAVE_DIR` derived from its
//! SHA-256 content hash (first 16 bytes as hex). This avoids collisions
//! from ROM renames and keeps saves independent of filename churn.
//!
//! Save Stack model:
//!   Save → pushes a new entry (chronological, never overwrites).
//!   Load → loads the top of the stack.
//!   Load earlier → pick any save from the stack.
//!
//! File layout:
//!   {GV_SAVE_DIR}/{hash[:16]}/
//!     stack.json              ← save stack metadata
//!     state-0001.state        ← save entries (sequential, never reused)
//!     state-0002.state
//!     ...
//!     battery.srm             ← auto-save on unload (separate from stack)

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::io;
use std::path::{Path, PathBuf};

// ── Save stack metadata ─────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SaveEntry {
    pub index: u32,
    pub timestamp: String, // ISO 8601
    pub size: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SaveStack {
    pub next_index: u32,
    pub entries: Vec<SaveEntry>,
}

impl SaveStack {
    fn new() -> Self {
        Self {
            next_index: 1,
            entries: vec![],
        }
    }

    fn push(&mut self, size: u64) -> u32 {
        let index = self.next_index;
        let ts = match std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH) {
            Ok(d) => d.as_secs().to_string(),
            Err(_) => "0".to_string(),
        };
        let entry = SaveEntry {
            index,
            timestamp: ts,
            size,
        };
        self.entries.push(entry);
        self.next_index += 1;
        index
    }

    fn latest_index(&self) -> Option<u32> {
        self.entries.last().map(|e| e.index)
    }
}

// ── Path helpers ─────────────────────────────────────────────────────

/// GV_SAVE_DIR env var, defaults to `/tmp/sc-saves`.
pub fn save_root() -> PathBuf {
    std::env::var("GV_SAVE_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("/tmp/sc-saves"))
}

/// Hash a ROM file's contents and return the first 16 bytes as lowercase hex.
///
/// Returns `None` if the file can't be read (e.g. 2048 core has no ROM).
pub fn hash_rom(rom_path: &Path) -> Option<String> {
    let data = std::fs::read(rom_path).ok()?;
    let mut hasher = Sha256::new();
    hasher.update(&data);
    let result = hasher.finalize();
    Some(hex::encode(&result[..16]))
}

/// Directory for a ROM's saves: `{GV_SAVE_DIR}/{rom_hash}/`.
pub fn save_dir_for(rom_hash: &str) -> PathBuf {
    save_root().join(rom_hash)
}

/// Path to the battery SRAM file for a ROM hash.
pub fn sram_path(rom_hash: &str) -> PathBuf {
    save_dir_for(rom_hash).join("battery.srm")
}

/// Path to a numbered save state file.
fn state_path(rom_hash: &str, index: u32) -> PathBuf {
    save_dir_for(rom_hash).join(format!("state-{:04}.state", index))
}

/// Path to the stack metadata file.
fn stack_path(rom_hash: &str) -> PathBuf {
    save_dir_for(rom_hash).join("stack.json")
}

// ── Stack operations ─────────────────────────────────────────────────

/// Read the stack metadata, or return an empty stack if none exists.
fn read_stack(rom_hash: &str) -> io::Result<SaveStack> {
    let path = stack_path(rom_hash);
    if !path.exists() {
        return Ok(SaveStack::new());
    }
    let data = std::fs::read(&path)?;
    serde_json::from_slice(&data).map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))
}

/// Write the stack metadata atomically.
fn write_stack(rom_hash: &str, stack: &SaveStack) -> io::Result<()> {
    let data = serde_json::to_vec_pretty(stack)
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
    write_atomic(&stack_path(rom_hash), &data)
}

/// Push a save state onto the stack. Writes the state data to disk
/// and updates stack.json. Returns the new entry index.
pub fn save_stack_push(rom_hash: &str, data: &[u8]) -> io::Result<u32> {
    let mut stack = read_stack(rom_hash)?;
    let index = stack.push(data.len() as u64);

    // Write state file first (if this fails, stack wasn't updated yet)
    write_atomic(&state_path(rom_hash, index), data)?;

    // Then update stack metadata
    write_stack(rom_hash, &stack)?;

    Ok(index)
}

/// Load a save state from the stack by index. Returns the raw state data.
pub fn save_stack_load(rom_hash: &str, index: u32) -> io::Result<Vec<u8>> {
    let path = state_path(rom_hash, index);
    std::fs::read(&path)
}

/// Load the latest (top) save state.
pub fn save_stack_load_latest(rom_hash: &str) -> io::Result<Option<(u32, Vec<u8>)>> {
    let stack = read_stack(rom_hash)?;
    match stack.latest_index() {
        Some(idx) => {
            let data = save_stack_load(rom_hash, idx)?;
            Ok(Some((idx, data)))
        }
        None => Ok(None),
    }
}

/// List all save entries with metadata.
pub fn save_stack_list(rom_hash: &str) -> io::Result<SaveStack> {
    read_stack(rom_hash)
}

// ── Atomic write ─────────────────────────────────────────────────────

/// Atomic file write: write to .tmp, fsync, rename.
///
/// The rename is atomic on the same filesystem (POSIX guarantee).
///
/// Returns an error if any I/O step fails. Callers should log and continue
/// — losing a save is bad, but crashing the server is worse.
pub(crate) fn write_atomic(path: &Path, data: &[u8]) -> io::Result<()> {
    let tmp_path = path.with_extension("tmp");

    // Ensure parent directories exist
    if let Some(parent) = tmp_path.parent() {
        std::fs::create_dir_all(parent)?;
    }

    // Write to temp file
    std::fs::write(&tmp_path, data)?;

    // fsync the temp file (ensures data is on disk before rename)
    let file = std::fs::File::open(&tmp_path)?;
    file.sync_all()?;

    // Atomic rename
    std::fs::rename(&tmp_path, path)?;

    Ok(())
}
