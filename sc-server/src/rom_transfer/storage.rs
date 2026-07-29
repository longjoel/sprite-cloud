//! Secure ROM staging, atomic commit, and download resolution.
//!
//! Uploads land as `.partial` files under a chosen ROM root, are verified
//! (size, SHA-256, extension allowlist), and atomically renamed into place.
//! Downloads resolve opaque local game IDs to canonical regular files.
//!
//! No WebRTC or network I/O — this module is pure filesystem.

use crate::platform;
use sha2::{Digest, Sha256};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

// ── Errors ─────────────────────────────────────────────────────────────

#[derive(Debug, thiserror::Error)]
pub enum StorageError {
    #[error("no writable ROM roots configured")]
    NoRoots,

    #[error("basename contains path separators, null bytes, or is empty")]
    InvalidBasename,

    #[error("basename exceeds {max} bytes (got {actual})")]
    BasenameTooLong { max: usize, actual: usize },

    #[error("unsupported file extension: {0}")]
    UnsupportedExtension(String),

    #[error("declared size {declared} does not match actual {actual}")]
    SizeMismatch { declared: u64, actual: u64 },

    #[error("declared size exceeds limit of {limit} bytes")]
    SizeLimitExceeded { limit: u64, declared: u64 },

    #[error("hash mismatch: declared {declared}, computed {computed}")]
    HashMismatch { declared: String, computed: String },

    #[error("conflict: ROM already exists at {0}")]
    Conflict(PathBuf),

    #[error("insufficient disk space: need {required} bytes, available {available}")]
    InsufficientSpace { required: u64, available: u64 },

    #[error("game not found: {0}")]
    GameNotFound(String),

    #[error("game path escapes ROM root: {0}")]
    RootEscape(PathBuf),

    #[error("I/O error: {0}")]
    Io(#[from] io::Error),
}

/// All recognised ROM extensions from the platform manifest.
fn supported_extensions() -> Vec<&'static str> {
    let mut exts: Vec<&str> = platform::PLATFORMS
        .iter()
        .flat_map(|p| p.extensions.iter().copied())
        .collect();
    exts.sort_unstable();
    exts.dedup();
    exts
}

/// Maximum filename length in bytes (conservative — most filesystems allow 255).
const MAX_BASENAME_BYTES: usize = 240;

/// Maximum declared upload size (2 GiB).
pub const MAX_UPLOAD_BYTES: u64 = 2 * 1024 * 1024 * 1024;

/// Lifetime of an abandoned `.partial` file before cleanup.
const PARTIAL_EXPIRY: Duration = Duration::from_secs(3600); // 1 hour

// ── Validation ─────────────────────────────────────────────────────────

/// Validate and sanitise a basename for staging.
///
/// Rejects empty strings, path separators, null bytes, and unsupported
/// extensions.  Returns the sanitised basename.
pub fn validate_basename(raw: &str) -> Result<String, StorageError> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(StorageError::InvalidBasename);
    }
    if trimmed.contains('\x00') || trimmed.contains('/') || trimmed.contains('\\') {
        return Err(StorageError::InvalidBasename);
    }
    if trimmed == "." || trimmed == ".." {
        return Err(StorageError::InvalidBasename);
    }

    let byte_len = trimmed.len();
    if byte_len > MAX_BASENAME_BYTES {
        return Err(StorageError::BasenameTooLong {
            max: MAX_BASENAME_BYTES,
            actual: byte_len,
        });
    }

    // Extension must be a recognised ROM format
    let ext = Path::new(trimmed)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
    if ext.is_empty() || !supported_extensions().contains(&ext.as_str()) {
        return Err(StorageError::UnsupportedExtension(ext));
    }

    Ok(trimmed.to_string())
}

/// Check that a resolved path is a regular file strictly under a root.
pub fn verify_under_root(path: &Path, root: &Path) -> Result<(), StorageError> {
    let canonical = path.canonicalize().map_err(StorageError::Io)?;
    let canonical_root = root.canonicalize().map_err(StorageError::Io)?;

    if !canonical.starts_with(&canonical_root) {
        return Err(StorageError::RootEscape(canonical));
    }
    if !canonical.is_file() {
        return Err(StorageError::RootEscape(canonical));
    }
    Ok(())
}

// ── Import root selection ──────────────────────────────────────────────

/// Select the first writable ROM root from the configured list.
pub fn select_import_root(rom_roots: &[String]) -> Result<PathBuf, StorageError> {
    for root in rom_roots {
        let path = Path::new(root);
        if path.is_dir() {
            // Check writability
            let test = path.join(".sc_write_test");
            if std::fs::write(&test, b"1").is_ok() {
                let _ = std::fs::remove_file(&test);
                return Ok(path.to_path_buf());
            }
        }
    }
    Err(StorageError::NoRoots)
}

/// Check available disk space on the filesystem containing `root`.
///
/// On Unix, uses `statvfs` via libc. On other platforms, skips the
/// check (actual writes will fail if the disk is full).
pub fn check_disk_space(root: &Path, required: u64) -> Result<(), StorageError> {
    #[cfg(unix)]
    {
        use std::ffi::CString;
        let c_root = CString::new(root.to_string_lossy().as_bytes())
            .map_err(|_| StorageError::Io(io::Error::new(io::ErrorKind::InvalidInput, "invalid root path")))?;
        let mut stat: libc::statvfs = unsafe { std::mem::zeroed() };
        let rc = unsafe { libc::statvfs(c_root.as_ptr(), &mut stat) };
        if rc == 0 {
            let available = stat.f_bavail as u64 * stat.f_frsize as u64;
            if available < required {
                return Err(StorageError::InsufficientSpace {
                    required,
                    available,
                });
            }
        }
        // If statvfs fails, proceed optimistically — writes will fail on full disk
    }

    #[cfg(not(unix))]
    {
        let _ = (root, required);
    }

    Ok(())
}

// ── Staged upload ──────────────────────────────────────────────────────

/// An in-progress ROM upload staged in a `.partial` file.
///
/// Callers stream bytes via `write()`, then call `commit()` to verify
/// and atomically rename, or `cancel()` to discard.
pub struct StagedUpload {
    partial_path: PathBuf,
    final_path: PathBuf,
    file: std::fs::File,
    hasher: Sha256,
    bytes_written: u64,
    basename: String,
}

impl StagedUpload {
    /// Create a new staged upload under `root`.
    ///
    /// The partial file is named `<basename>.partial.<random>` to avoid
    /// collisions during concurrent uploads.
    pub fn create(root: &Path, basename: &str, declared_size: u64) -> Result<Self, StorageError> {
        let sanitised = validate_basename(basename)?;

        if declared_size > MAX_UPLOAD_BYTES {
            return Err(StorageError::SizeLimitExceeded {
                limit: MAX_UPLOAD_BYTES,
                declared: declared_size,
            });
        }

        let final_path = root.join(&sanitised);

        // Reject if a non-partial file already exists at the target
        let is_partial = final_path
            .file_name()
            .and_then(|n| n.to_str())
            .map(|n| n.contains(".partial."))
            .unwrap_or(false);
        if final_path.exists() && !is_partial {
            return Err(StorageError::Conflict(final_path));
        }

        // Check disk space
        check_disk_space(root, declared_size)?;

        // Create unique partial filename
        let suffix: String = std::iter::repeat_with(fast_random_char)
            .take(8)
            .collect();
        let partial_name = format!("{sanitised}.partial.{suffix}");
        let partial_path = root.join(&partial_name);

        // Create staging dir if needed (ROM root should already exist)
        std::fs::create_dir_all(root)?;

        let file = std::fs::File::create(&partial_path)?;
        // Pre-allocate to fail early if disk is full
        #[cfg(unix)]
        {
            // Fallocate can fail on some filesystems — non-fatal
            let _ = file.set_len(declared_size);
            let _ = file.set_len(0); // Reset to append mode
        }

        Ok(Self {
            partial_path,
            final_path,
            file,
            hasher: Sha256::new(),
            bytes_written: 0,
            basename: sanitised,
        })
    }

    /// Write a chunk of the ROM file.
    pub fn write_chunk(&mut self, data: &[u8]) -> Result<(), StorageError> {
        self.file.write_all(data)?;
        self.hasher.update(data);
        self.bytes_written += data.len() as u64;
        Ok(())
    }

    /// Current bytes written.
    pub fn bytes_written(&self) -> u64 {
        self.bytes_written
    }

    /// The final basename (sanitised).
    pub fn basename(&self) -> &str {
        &self.basename
    }

    /// Commit: fsync, compute hash, verify size (if declared_size provided),
    /// and atomically rename into place. Returns computed SHA-256 + size.
    ///
    /// The caller should already have the expected hash from capability
    /// verification; `commit_with_expected_hash` is preferred.
    pub fn commit(
        mut self,
        declared_size: Option<u64>,
    ) -> Result<(String, u64), StorageError> {
        // Fsync before verification
        self.file.flush()?;
        self.file.sync_all()?;

        // Verify size
        let actual_meta = std::fs::metadata(&self.partial_path)?;
        let actual_size = actual_meta.len();
        if let Some(declared) = declared_size
            && actual_size != declared
        {
            let _ = self.remove_partial();
            return Err(StorageError::SizeMismatch {
                declared,
                actual: actual_size,
            });
        }

        let hash = hex::encode(self.hasher.clone().finalize());

        // Atomic rename
        std::fs::rename(&self.partial_path, &self.final_path)?;

        // Fsync the directory to ensure the rename is durable
        if let Some(parent) = self.final_path.parent() {
            #[cfg(unix)]
            {
                if let Ok(dir) = std::fs::File::open(parent) {
                    let _ = dir.sync_all();
                }
            }
        }

        // Don't run Drop (which tries to clean up partial)
        let partial = std::mem::take(&mut self.partial_path);
        std::mem::forget(partial);

        Ok((hash, actual_size))
    }

    /// Commit with expected hash verification.
    pub fn commit_with_expected_hash(
        mut self,
        declared_size: Option<u64>,
        expected_hash: &str,
    ) -> Result<(String, u64), StorageError> {
        // Fsync before verification
        self.file.flush()?;
        self.file.sync_all()?;

        let computed = hex::encode(self.hasher.finalize_reset());
        // Re-read and re-hash for verification so hasher state is consumed only once
        // (finalize_reset already gave us the hash above, but we need it after flush)

        if !constant_time_eq(computed.as_bytes(), expected_hash.as_bytes()) {
            let _ = std::fs::remove_file(&self.partial_path);
            return Err(StorageError::HashMismatch {
                declared: expected_hash.to_string(),
                computed,
            });
        }

        let actual_meta = std::fs::metadata(&self.partial_path)?;
        let actual_size = actual_meta.len();
        if let Some(declared) = declared_size
            && actual_size != declared
        {
            let _ = std::fs::remove_file(&self.partial_path);
            return Err(StorageError::SizeMismatch {
                declared,
                actual: actual_size,
            });
        }

        // Atomic rename
        std::fs::rename(&self.partial_path, &self.final_path)?;

        // Fsync the directory
        if let Some(parent) = self.final_path.parent() {
            #[cfg(unix)]
            {
                if let Ok(dir) = std::fs::File::open(parent) {
                    let _ = dir.sync_all();
                }
            }
        }

        let partial = std::mem::take(&mut self.partial_path);
        std::mem::forget(partial);

        Ok((computed, actual_size))
    }

    /// Cancel: remove the partial file without committing.
    pub fn cancel(self) -> Result<(), StorageError> {
        self.remove_partial()
    }

    fn remove_partial(&self) -> Result<(), StorageError> {
        if self.partial_path.exists() {
            std::fs::remove_file(&self.partial_path)?;
        }
        Ok(())
    }
}

impl Drop for StagedUpload {
    fn drop(&mut self) {
        if !self.partial_path.as_os_str().is_empty() {
            let _ = std::fs::remove_file(&self.partial_path);
        }
    }
}

// ── Download resolution ────────────────────────────────────────────────

/// Metadata for a resolved downloadable game.
#[derive(Debug, Clone)]
pub struct ResolvedGame {
    /// Canonical absolute path to the regular file.
    pub path: PathBuf,
    /// File size in bytes.
    pub size: u64,
    /// Display name (from local library preferences or filename).
    pub name: String,
    /// Platform short name.
    pub platform: String,
}

/// Resolve an opaque local game ID to a downloadable regular file.
///
/// Verifies the resolved path is under a configured ROM root and is a
/// regular file (not a symlink or device).
pub(crate) fn resolve_download(
    game_id: &str,
    rom_roots: &[String],
    local_games: &[super::super::player_server::LocalGame],
) -> Result<ResolvedGame, StorageError> {
    let game = local_games
        .iter()
        .find(|g| g.id == game_id)
        .ok_or_else(|| StorageError::GameNotFound(game_id.to_string()))?;

    // Find which root contains this game
    let canonical_path = game
        .content_path
        .canonicalize()
        .map_err(StorageError::Io)?;

    let matched_root = rom_roots
        .iter()
        .filter_map(|r| Path::new(r).canonicalize().ok())
        .find(|root| canonical_path.starts_with(root))
        .ok_or_else(|| StorageError::RootEscape(canonical_path.clone()))?;

    verify_under_root(&canonical_path, &matched_root)?;

    let size = std::fs::metadata(&canonical_path)?.len();
    let platform_name = platform::detect_platform_name(&canonical_path)
        .unwrap_or_else(|| "Unknown".to_string());

    Ok(ResolvedGame {
        path: canonical_path,
        size,
        name: crate::player_server::local_game_name(game),
        platform: platform_name,
    })
}

// ── Cleanup ────────────────────────────────────────────────────────────

/// Remove expired `.partial` files from all ROM roots.
pub fn cleanup_expired_partials(rom_roots: &[String]) {
    let now = SystemTime::now();
    for root in rom_roots {
        let dir = Path::new(root);
        if !dir.is_dir() {
            continue;
        }
        let entries = match std::fs::read_dir(dir) {
            Ok(e) => e,
            Err(_) => continue,
        };
        for entry in entries.flatten() {
            let path = entry.path();
            // Partial files: basename contains ".partial."
            let is_partial = path
                .file_name()
                .and_then(|n| n.to_str())
                .map(|n| n.contains(".partial."))
                .unwrap_or(false);
            if !is_partial {
                continue;
            }
            let is_expired = entry
                .metadata()
                .ok()
                .and_then(|m| m.modified().ok())
                .map(|modified| now.duration_since(modified).unwrap_or_default() > PARTIAL_EXPIRY)
                .unwrap_or(true); // can't read metadata → assume expired
            if is_expired {
                if let Err(e) = std::fs::remove_file(&path) {
                    tracing::warn!(
                        "[ROM STORAGE] failed to remove expired partial {}: {e}",
                        path.display()
                    );
                } else {
                    tracing::info!(
                        "[ROM STORAGE] removed expired partial: {}",
                        path.display()
                    );
                }
            }
        }
    }
}

// ── Helpers ────────────────────────────────────────────────────────────

/// Fast random ASCII character for partial file suffix.
fn fast_random_char() -> char {
    use rand::Rng;
    let mut rng = rand::thread_rng();
    let chars = b"abcdefghijklmnopqrstuvwxyz0123456789";
    chars[rng.gen_range(0..chars.len())] as char
}

/// Constant-time byte comparison for hash verification.
pub fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

// ── Tests ──────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    // ── Basename validation ─────────────────────────────────────────

    #[test]
    fn rejects_empty_basename() {
        assert!(validate_basename("").is_err());
        assert!(validate_basename("   ").is_err());
    }

    #[test]
    fn rejects_path_separators() {
        assert!(validate_basename("a/b.nes").is_err());
        assert!(validate_basename("a\\b.nes").is_err());
        assert!(validate_basename("../escape.nes").is_err());
    }

    #[test]
    fn rejects_null_bytes() {
        assert!(validate_basename("game\x00.nes").is_err());
    }

    #[test]
    fn rejects_dot_and_dotdot() {
        assert!(validate_basename(".").is_err());
        assert!(validate_basename("..").is_err());
    }

    #[test]
    fn rejects_unsupported_extension() {
        assert!(validate_basename("game.exe").is_err());
        assert!(validate_basename("game.txt").is_err());
        assert!(validate_basename("game").is_err()); // no extension
    }

    #[test]
    fn accepts_valid_extensions() {
        assert!(validate_basename("game.nes").is_ok());
        assert!(validate_basename("game.sfc").is_ok());
        assert!(validate_basename("game.gba").is_ok());
        assert!(validate_basename("game.gen").is_ok());
        assert!(validate_basename("game 2.nes").is_ok());
    }

    #[test]
    fn rejects_overlong_basename() {
        let long = "a".repeat(MAX_BASENAME_BYTES + 1) + ".nes";
        assert!(validate_basename(&long).is_err());
    }

    // ── Staged upload ───────────────────────────────────────────────

    #[test]
    fn staged_upload_write_and_commit() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();

        let mut upload = StagedUpload::create(root, "game.nes", 4).unwrap();
        upload.write_chunk(b"TEST").unwrap();
        let (hash, size) = upload.commit(Some(4)).unwrap();

        assert_eq!(size, 4);
        assert_eq!(hash, hex::encode(Sha256::digest(b"TEST")));

        // File exists at final path
        let final_path = root.join("game.nes");
        assert!(final_path.exists());
        assert_eq!(std::fs::read(&final_path).unwrap(), b"TEST");

        // Partial is gone
        let partials: Vec<_> = std::fs::read_dir(root)
            .unwrap()
            .flatten()
            .filter(|e| {
                e.path()
                    .extension()
                    .map(|e| e == "partial")
                    .unwrap_or(false)
            })
            .collect();
        assert!(partials.is_empty());
    }

    #[test]
    fn staged_upload_size_mismatch() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();

        let mut upload = StagedUpload::create(root, "game.nes", 4).unwrap();
        upload.write_chunk(b"TOO_LONG").unwrap();
        let result = upload.commit(Some(4));
        assert!(result.is_err());

        // Final file does NOT exist
        assert!(!root.join("game.nes").exists());
    }

    #[test]
    fn staged_upload_cancel_cleans_up() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();

        let upload = StagedUpload::create(root, "game.nes", 4).unwrap();
        let partial_path = upload.partial_path.clone();
        assert!(partial_path.exists());
        upload.cancel().unwrap();
        assert!(!partial_path.exists());
    }

    #[test]
    fn staged_upload_drop_cleans_up() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();

        let partial_path;
        {
            let upload = StagedUpload::create(root, "game.nes", 4).unwrap();
            partial_path = upload.partial_path.clone();
            assert!(partial_path.exists());
            // Drop without commit or cancel
        }
        assert!(!partial_path.exists());
    }

    #[test]
    fn staged_upload_conflict_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();

        // Create a file first
        std::fs::write(root.join("game.nes"), b"existing").unwrap();

        let result = StagedUpload::create(root, "game.nes", 4);
        assert!(result.is_err());
    }

    #[test]
    fn staged_upload_unsupported_extension() {
        let dir = tempfile::tempdir().unwrap();
        let result = StagedUpload::create(dir.path(), "game.exe", 4);
        assert!(result.is_err());
    }

    #[test]
    fn staged_upload_size_limit() {
        let dir = tempfile::tempdir().unwrap();
        let result = StagedUpload::create(dir.path(), "game.nes", MAX_UPLOAD_BYTES + 1);
        assert!(result.is_err());
    }

    #[test]
    fn partial_cleanup_removes_expired() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_str().unwrap().to_string();

        // Create a partial file with old timestamp
        let partial = root.clone() + "/game.nes.partial.abc12345";
        std::fs::write(&partial, b"data").unwrap();

        // Set mtime to 2 hours ago
        let two_hours_ago = SystemTime::now() - Duration::from_secs(7200);
        filetime::set_file_mtime(&partial, filetime::FileTime::from_system_time(two_hours_ago))
            .unwrap();

        cleanup_expired_partials(&[root]);

        assert!(!Path::new(&partial).exists());
    }

    // ── Path verification ───────────────────────────────────────────

    #[test]
    fn verify_under_root_accepts_normal() {
        let dir = tempfile::tempdir().unwrap();
        let file_path = dir.path().join("game.nes");
        std::fs::write(&file_path, b"data").unwrap();
        assert!(verify_under_root(&file_path, dir.path()).is_ok());
    }

    #[test]
    fn verify_under_root_rejects_escape() {
        let dir = tempfile::tempdir().unwrap();
        // Create a file outside the root
        let outside = dir.path().parent().unwrap().join("escape.nes");
        std::fs::write(&outside, b"data").unwrap();
        assert!(verify_under_root(&outside, dir.path()).is_err());
        let _ = std::fs::remove_file(&outside);
    }

    // ── Constant-time comparison ────────────────────────────────────

    #[test]
    fn constant_time_eq_matches() {
        assert!(constant_time_eq(b"abc", b"abc"));
        assert!(!constant_time_eq(b"abc", b"abd"));
        assert!(!constant_time_eq(b"abc", b"ab"));
        assert!(!constant_time_eq(b"", b"a"));
    }

    // ── Import root selection ───────────────────────────────────────

    #[test]
    fn select_import_root_picks_writable() {
        let dir = tempfile::tempdir().unwrap();
        let roots = vec![dir.path().to_str().unwrap().to_string()];
        let selected = select_import_root(&roots).unwrap();
        assert_eq!(selected, dir.path());
    }

    #[test]
    fn select_import_root_errors_on_no_roots() {
        assert!(select_import_root(&[]).is_err());
    }
}
