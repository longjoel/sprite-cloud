//! Save file persistence — ROM hashing, directory layout, atomic writes.
//!
//! Every ROM gets a stable directory under `GV_SAVE_DIR` derived from its
//! SHA-256 content hash (first 16 bytes as hex). This avoids collisions
//! from ROM renames and keeps saves independent of filename churn.
//!
//! File layout:
//!   {GV_SAVE_DIR}/{hash[:16]}/
//!     battery.srm        ← auto-save on unload
//!     states/
//!       slot-01.state     ← manual save state
//!       ...
//!       slot-09.state

use sha2::{Digest, Sha256};
use std::io;
use std::path::{Path, PathBuf};

/// GV_SAVE_DIR env var, defaults to `/tmp/gv-saves`.
pub fn save_root() -> PathBuf {
    std::env::var("GV_SAVE_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("/tmp/gv-saves"))
}

/// Hash a ROM file's contents and return the first 16 bytes as lowercase hex.
///
/// Returns `None` if the file can't be read (e.g. 2048 core has no ROM).
pub fn hash_rom(rom_path: &Path) -> Option<String> {
    let data = std::fs::read(rom_path).ok()?;
    let mut hasher = Sha256::new();
    hasher.update(&data);
    let result = hasher.finalize();
    // First 16 bytes → 32 hex chars
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

/// Path to a numbered save state slot (1–9).
pub fn state_path(rom_hash: &str, slot: u8) -> PathBuf {
    save_dir_for(rom_hash)
        .join("states")
        .join(format!("slot-{:02}.state", slot))
}

/// Atomic file write: write to .tmp, fsync, rename.
///
/// The rename is atomic on the same filesystem (POSIX guarantee).
///
/// Returns an error if any I/O step fails. Callers should log and continue
/// — losing a save is bad, but crashing the worker is worse.
pub fn write_atomic(path: &Path, data: &[u8]) -> io::Result<()> {
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
