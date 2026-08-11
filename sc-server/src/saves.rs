//! Save file persistence — ROM hashing, directory layout, atomic writes.
//!
//! Every ROM gets a stable directory under `GV_SAVE_DIR` derived from its
//! SHA-256 content hash (first 16 bytes as hex). This avoids collisions
//! from ROM renames and keeps saves independent of filename churn.
//!
//! Artifacts are per-account (#745): the save root is
//! `{GV_SAVE_DIR}/{account_id}/{rom_hash}/`. Two accounts playing the same
//! ROM never see each other's saves. Before a session has resolved its
//! account (core startup SRAM auto-load), callers pass `"shared"` as the
//! account id so pre-auth persistence still works.
//!
//! Save Stack model:
//!   Save → pushes a new entry (chronological, never overwrites).
//!   Load → loads the top of the stack.
//!   Load earlier → pick any save from the stack.
//!
//! File layout:
//!   {GV_SAVE_DIR}/{account_id}/{hash[:16]}/
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

/// Directory for an account's saves of a ROM:
/// `{GV_SAVE_DIR}/{account_id}/{rom_hash}/`.
pub fn save_dir_for(account_id: &str, rom_hash: &str) -> PathBuf {
    save_root().join(account_id).join(rom_hash)
}

/// Path to the battery SRAM file for an account's ROM.
pub fn sram_path(account_id: &str, rom_hash: &str) -> PathBuf {
    save_dir_for(account_id, rom_hash).join("battery.srm")
}

/// Path to a numbered save state file.
fn state_path(account_id: &str, rom_hash: &str, index: u32) -> PathBuf {
    save_dir_for(account_id, rom_hash).join(format!("state-{:04}.state", index))
}

/// Path to the stack metadata file.
fn stack_path(account_id: &str, rom_hash: &str) -> PathBuf {
    save_dir_for(account_id, rom_hash).join("stack.json")
}

// ── Stack operations ─────────────────────────────────────────────────

/// Read the stack metadata, or return an empty stack if none exists.
fn read_stack(account_id: &str, rom_hash: &str) -> io::Result<SaveStack> {
    let path = stack_path(account_id, rom_hash);
    if !path.exists() {
        return Ok(SaveStack::new());
    }
    let data = std::fs::read(&path)?;
    serde_json::from_slice(&data).map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))
}

/// Write the stack metadata atomically.
fn write_stack(account_id: &str, rom_hash: &str, stack: &SaveStack) -> io::Result<()> {
    let data = serde_json::to_vec_pretty(stack)
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
    write_atomic(&stack_path(account_id, rom_hash), &data)
}

/// Push a save state onto the stack. Writes the state data to disk
/// and updates stack.json. Returns the new entry index.
pub fn save_stack_push(account_id: &str, rom_hash: &str, data: &[u8]) -> io::Result<u32> {
    let mut stack = read_stack(account_id, rom_hash)?;
    let index = stack.push(data.len() as u64);

    // Write state file first (if this fails, stack wasn't updated yet)
    write_atomic(&state_path(account_id, rom_hash, index), data)?;

    // Then update stack metadata
    write_stack(account_id, rom_hash, &stack)?;

    Ok(index)
}

/// Load a save state from the stack by index. Returns the raw state data.
pub fn save_stack_load(account_id: &str, rom_hash: &str, index: u32) -> io::Result<Vec<u8>> {
    let path = state_path(account_id, rom_hash, index);
    std::fs::read(&path)
}

/// Load the latest (top) save state.
pub fn save_stack_load_latest(account_id: &str, rom_hash: &str) -> io::Result<Option<(u32, Vec<u8>)>> {
    let stack = read_stack(account_id, rom_hash)?;
    match stack.latest_index() {
        Some(idx) => {
            let data = save_stack_load(account_id, rom_hash, idx)?;
            Ok(Some((idx, data)))
        }
        None => Ok(None),
    }
}

/// List all save entries with metadata.
pub fn save_stack_list(account_id: &str, rom_hash: &str) -> io::Result<SaveStack> {
    read_stack(account_id, rom_hash)
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

#[cfg(test)]
mod tests {
    use super::*;
    use serial_test::serial;

    /// Isolation invariant (#745): two accounts saving the same ROM must
    /// land in separate directories — each list only sees its own entries.
    #[test]
    #[serial]
    fn save_stack_is_isolated_per_account() {
        let tmp = tempfile::tempdir().unwrap();
        // SAFETY: test-only env mutation; serial_test ensures no parallel
        // test reads GV_SAVE_DIR concurrently.
        unsafe { std::env::set_var("GV_SAVE_DIR", tmp.path()) };
        let rom = "abc123";

        let alice = save_stack_push("alice", rom, b"alice-state-1").unwrap();
        let bob = save_stack_push("bob", rom, b"bob-state-1").unwrap();
        let _ = save_stack_push("alice", rom, b"alice-state-2").unwrap();

        // Alice sees her two entries; Bob sees only his one.
        let alice_list = save_stack_list("alice", rom).unwrap();
        let bob_list = save_stack_list("bob", rom).unwrap();
        assert_eq!(alice_list.entries.len(), 2);
        assert_eq!(bob_list.entries.len(), 1);

        // Alice's load by index returns Alice's data, Bob's returns Bob's.
        let alice_data = save_stack_load("alice", rom, alice).unwrap();
        let bob_data = save_stack_load("bob", rom, bob).unwrap();
        assert_eq!(alice_data, b"alice-state-1");
        assert_eq!(bob_data, b"bob-state-1");
    }

    /// The pre-auth `shared` fallback keeps core-startup SRAM working:
    /// auto-load before the DC auth message resolves an account.
    #[test]
    #[serial]
    fn shared_fallback_has_its_own_slot() {
        let tmp = tempfile::tempdir().unwrap();
        // SAFETY: test-only env mutation; serial_test ensures no parallel
        // test reads GV_SAVE_DIR concurrently.
        unsafe { std::env::set_var("GV_SAVE_DIR", tmp.path()) };
        let rom = "abc123";

        let _ = save_stack_push("shared", rom, b"legacy");
        let alice_list = save_stack_list("alice", rom).unwrap();
        assert!(alice_list.entries.is_empty());
    }
}
