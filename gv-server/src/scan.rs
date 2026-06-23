//! ROM scanner — walk directories, discover files, browse file trees.
//!
//! # Security
//! All filesystem access goes through `resolve_within_roots()` which
//! canonicalizes the path and verifies it's within the server's configured
//! `rom_roots`. This blocks path traversal (`../../etc/passwd`) and
//! symlink escapes.

use anyhow::{Context, Result};
use serde::Serialize;
use std::path::{Path, PathBuf};

// ── Constants ──────────────────────────────────────────────────────────

/// Maximum nesting depth for file tree browsing.
const BROWSE_MAX_DEPTH: u32 = 4;

// ── Path traversal guard ───────────────────────────────────────────────

/// Resolve a user-supplied path against the server's ROM roots.
///
/// Canonicalizes the path (resolves `..`, symlinks) and verifies the
/// result is within at least one of the configured roots. Returns the
/// canonical path, or an error if the path escapes containment.
pub fn resolve_within_roots(path: &Path, roots: &[String]) -> Result<PathBuf> {
    let candidate = std::fs::canonicalize(path)
        .with_context(|| format!("path does not exist or is inaccessible: {}", path.display()))?;

    let mut matched = false;
    let mut root_paths = Vec::new();

    for root in roots {
        let root_canon = std::fs::canonicalize(root)
            .with_context(|| format!("rom root does not exist: {root}"))?;
        root_paths.push(root_canon.display().to_string());

        if candidate.starts_with(&root_canon) || candidate == root_canon {
            matched = true;
            break;
        }
    }

    if !matched {
        anyhow::bail!(
            "path outside rom_roots: {} — must be within one of: {}",
            path.display(),
            root_paths.join(", ")
        );
    }

    Ok(candidate)
}

// ── ROM discovery ──────────────────────────────────────────────────────

/// One discovered ROM file with metadata.
#[derive(Debug, Clone, Serialize)]
pub struct DiscoveredFile {
    /// Path relative to the ROM root.
    pub relative_path: String,
    /// Filename only.
    pub file_name: String,
    /// Size in bytes.
    pub file_size: u64,
    /// SHA256 hex digest (populated by `hash_files`).
    pub sha256: Option<String>,
    /// CRC32 hex digest (populated by `hash_files`).
    pub crc: Option<String>,
    /// Detected platform from extension or directory name.
    pub platform: Option<String>,
}

/// Recursively walk a directory and discover ROM files.
///
/// Only includes files whose extensions appear in [`EXTENSION_MAP`].
/// Symlinks are never followed.
pub fn discover_roms(root: &Path) -> Result<Vec<DiscoveredFile>> {
    let mut files = Vec::new();

    for entry in walkdir::WalkDir::new(root)
        .follow_links(false)
        .into_iter()
        .filter_map(|e| e.ok())
    {
        if !entry.file_type().is_file() {
            continue;
        }

        let path = entry.path();
        let ext = match path.extension().and_then(|e| e.to_str()) {
            Some(e) => e.to_lowercase(),
            None => continue,
        };

        // Only include known ROM extensions
        if crate::platform::by_extension(&ext).is_none() {
            continue;
        }

        let relative = path
            .strip_prefix(root)
            .unwrap_or(path)
            .to_string_lossy()
            .to_string();
        let platform = crate::platform::detect_platform_name(path);
        let file_size = entry.metadata().map(|m| m.len()).unwrap_or(0);

        files.push(DiscoveredFile {
            relative_path: relative,
            file_name: path
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .to_string(),
            file_size,
            sha256: None,
            crc: None,
            platform,
        });
    }

    files.sort_by(|a, b| a.relative_path.cmp(&b.relative_path));
    Ok(files)
}

/// Compute SHA256 + CRC32 for each file in place.
pub fn hash_files(files: &mut [DiscoveredFile], root: &Path) {
    for f in files {
        let full_path = root.join(&f.relative_path);
        if let Ok((sha, crc)) = crate::dat::hash_file(&full_path) {
            f.sha256 = Some(sha);
            f.crc = Some(crc);
        }
    }
}

// ── File tree browsing ─────────────────────────────────────────────────

/// A node in a browsable file tree.
#[derive(Debug, Clone, Serialize)]
pub struct TreeNode {
    pub name: String,
    #[serde(rename = "type")]
    pub node_type: String,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub children: Vec<TreeNode>,
}

/// Build a recursive file tree for UI browsing.
///
/// Directories are listed first, then files. Limited to `BROWSE_MAX_DEPTH`.
pub fn browse_path(root: &Path) -> TreeNode {
    build_tree(root, root, 0)
}

fn build_tree(_base: &Path, current: &Path, depth: u32) -> TreeNode {
    let name = current
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();

    if depth >= BROWSE_MAX_DEPTH {
        return TreeNode {
            name,
            node_type: "dir".into(),
            children: vec![],
        };
    }

    let mut children = Vec::new();
    if let Ok(entries) = std::fs::read_dir(current) {
        for entry in entries.flatten() {
            let path = entry.path();
            let ft = match entry.file_type() {
                Ok(t) => t,
                Err(_) => continue,
            };

            if ft.is_dir() {
                children.push(build_tree(_base, &path, depth + 1));
            } else if ft.is_file() {
                children.push(TreeNode {
                    name: path
                        .file_name()
                        .unwrap_or_default()
                        .to_string_lossy()
                        .to_string(),
                    node_type: "file".into(),
                    children: vec![],
                });
            }
        }
    }

    // Directories first, then alphabetical
    children.sort_by(|a, b| a.node_type.cmp(&b.node_type).then(a.name.cmp(&b.name)));

    TreeNode {
        name,
        node_type: "dir".into(),
        children,
    }
}

// ── Tests ──────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_within_roots_accepts_valid_path() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().to_string_lossy().to_string();
        let roots = vec![root];
        let path = tmp.path();

        let result = resolve_within_roots(path, &roots);
        assert!(result.is_ok());
    }

    #[test]
    fn resolve_within_roots_rejects_escape() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().to_string_lossy().to_string();
        let roots = vec![root];
        let path = tmp.path().join("..").join("..").join("etc");

        let result = resolve_within_roots(&path, &roots);
        assert!(result.is_err());
        let err = result.unwrap_err().to_string();
        assert!(err.contains("outside rom_roots"), "got: {err}");
    }

    #[test]
    fn resolve_within_roots_rejects_nonexistent() {
        let roots = vec!["/tmp/nonexistent-root-xyz".to_string()];
        let result = resolve_within_roots(Path::new("/tmp/nonexistent-root-xyz"), &roots);
        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains("does not exist"));
    }

    #[test]
    fn detect_platform_from_extension() {
        assert_eq!(
            crate::platform::detect_platform_name(Path::new("/roms/game.sfc")),
            Some("SNES".into())
        );
        assert_eq!(
            crate::platform::detect_platform_name(Path::new("/roms/game.nes")),
            Some("NES".into())
        );
    }

    #[test]
    fn detect_platform_falls_back_to_dir_name() {
        assert_eq!(
            crate::platform::detect_platform_name(Path::new("/roms/Nintendo - Game Boy/game.gb")),
            Some("Game Boy".into())
        );
    }

    #[test]
    fn detect_platform_unknown_extension() {
        assert_eq!(
            crate::platform::detect_platform_name(Path::new("/roms/game.xyz")),
            None
        );
    }

    #[test]
    fn discover_roms_finds_known_extensions() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("game.nes"), b"fake").unwrap();
        std::fs::write(tmp.path().join("readme.txt"), b"not a rom").unwrap();

        let files = discover_roms(tmp.path()).unwrap();
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].file_name, "game.nes");
        assert_eq!(files[0].relative_path, "game.nes");
        assert_eq!(files[0].platform.as_deref(), Some("NES"));
    }

    #[test]
    fn browse_path_returns_tree() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::create_dir(tmp.path().join("subdir")).unwrap();
        std::fs::write(tmp.path().join("rom.nes"), b"fake").unwrap();
        std::fs::write(tmp.path().join("subdir").join("rom2.gb"), b"fake").unwrap();

        let tree = browse_path(tmp.path());
        assert_eq!(tree.name, tmp.path().file_name().unwrap().to_str().unwrap());
        assert_eq!(tree.node_type, "dir");

        // subdir should appear first (dirs before files), then rom.nes
        let dir_child = tree.children.iter().find(|c| c.node_type == "dir").unwrap();
        assert_eq!(dir_child.name, "subdir");
        assert!(!dir_child.children.is_empty());

        let file_child = tree
            .children
            .iter()
            .find(|c| c.node_type == "file")
            .unwrap();
        assert_eq!(file_child.name, "rom.nes");
    }
}
