//! RetroArch thumbnail resolver and caching layer.
//!
//! Lazy-loads cover art from thumbnails.libretro.com when a game tile
//! is rendered. Downloads are cached locally by game ID — subsequent
//! views serve from disk without hitting the network.
//!
//! ## Design
//!
//! - **Source**: `https://thumbnails.libretro.com/{platform}/Named_Boxarts/{name}.png`
//! - **Cache**: `{covers_dir}/{game_id}.png` — one file per game, never re-downloaded
//! - **Validation**: checks PNG magic bytes + size cap (5 MiB)
//! - **Failure**: returns `None` — caller serves 404, web renders platform-color placeholder
//!
//! ## Platform name mapping
//!
//! RetroArch uses canonical DAT names as folder names.
//! Our `platform.rs` already carries these as `PlatformManifest::aliases`.
//! When a game has a DAT match, we use the DAT platform name directly.
//! For unmatched games, we fall back to our short platform name.

use std::path::{Path, PathBuf};

/// Maximum cover image size (5 MiB).
const MAX_COVER_BYTES: u64 = 5 * 1024 * 1024;

/// PNG magic bytes.
const PNG_MAGIC: [u8; 8] = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];

/// RetroArch thumbnail base URL.
const THUMBNAIL_BASE: &str = "https://thumbnails.libretro.com";

/// Result of a cover lookup.
#[derive(Debug)]
pub(crate) enum CoverResult {
    /// Cover is cached on disk at this path.
    Cached(PathBuf),
    /// Cover was not found (API returned 404 or game has no art).
    NotFound,
}

/// Resolve a cover for a game.
///
/// Checks the local cache first. On miss, fetches from the RetroArch
/// thumbnail server and caches the result.
///
/// `covers_dir` — writable directory for cached covers (created if missing).
/// `game_id` — the unique game ID used as the cache filename.
/// `platform_name` — RetroArch-era platform folder name (e.g. "Nintendo - Super Nintendo Entertainment System").
/// `game_name` — the game name as it appears in the DAT or ROM filename.
pub(crate) async fn resolve_cover(
    covers_dir: &Path,
    game_id: &str,
    platform_name: &str,
    game_name: &str,
) -> CoverResult {
    let cache_path = covers_dir.join(format!("{game_id}.png"));

    // ── Cache hit ─────────────────────────────────────────────────
    if cache_path.exists() {
        if let Ok(meta) = tokio::fs::metadata(&cache_path).await {
            if meta.len() > 0 {
                return CoverResult::Cached(cache_path);
            }
        }
    }

    // ── Cache miss — fetch from RetroArch ─────────────────────────
    let url = build_thumbnail_url(platform_name, game_name);
    tracing::info!("[COVER] fetching {url}");

    match download_cover(&url).await {
        Ok(bytes) => {
            // Validate before caching
            if !is_valid_png(&bytes) {
                tracing::warn!("[COVER] downloaded file is not a valid PNG: {url}");
                return CoverResult::NotFound;
            }

            // Write to cache
            if let Some(parent) = cache_path.parent() {
                let _ = tokio::fs::create_dir_all(parent).await;
            }
            match tokio::fs::write(&cache_path, &bytes).await {
                Ok(()) => {
                    tracing::info!(
                        "[COVER] cached {} bytes -> {}",
                        bytes.len(),
                        cache_path.display()
                    );
                    CoverResult::Cached(cache_path)
                }
                Err(e) => {
                    tracing::error!("[COVER] failed to write cache: {e}");
                    CoverResult::NotFound
                }
            }
        }
        Err(e) => {
            tracing::warn!("[COVER] download failed for {url}: {e}");
            CoverResult::NotFound
        }
    }
}

/// Build a RetroArch thumbnail URL for a given platform and game name.
///
/// URL pattern: `{base}/{platform}/Named_Boxarts/{name}.png`
///
/// Game names are URL-encoded. Special characters in platform names
/// (spaces, hyphens, slashes) are preserved as-is — RetroArch uses
/// them directly in folder names.
fn build_thumbnail_url(platform: &str, game_name: &str) -> String {
    // URL-encode the game name: spaces → %20, parens → %28/%29, etc.
    let encoded_name = urlencoding(&game_name);
    format!("{THUMBNAIL_BASE}/{platform}/Named_Boxarts/{encoded_name}.png")
}

/// Download cover bytes from a URL.
///
/// Respects the size limit and returns the raw bytes on success.
async fn download_cover(url: &str) -> Result<Vec<u8>, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| format!("client build: {e}"))?;

    let resp = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("request: {e}"))?;

    if resp.status() == reqwest::StatusCode::NOT_FOUND {
        return Err("404 not found".into());
    }

    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()));
    }

    // Check Content-Length if available
    if let Some(cl) = resp.content_length() {
        if cl > MAX_COVER_BYTES {
            return Err(format!("content-length {cl} exceeds max {MAX_COVER_BYTES}"));
        }
    }

    let bytes = resp
        .bytes()
        .await
        .map_err(|e| format!("read body: {e}"))?;

    if bytes.len() as u64 > MAX_COVER_BYTES {
        return Err(format!(
            "response size {} exceeds max {MAX_COVER_BYTES}",
            bytes.len()
        ));
    }

    Ok(bytes.to_vec())
}

/// Validate that bytes are a real PNG image.
///
/// Checks PNG magic header bytes. Does not fully decode — just
/// confirms the file claims to be a PNG.
fn is_valid_png(bytes: &[u8]) -> bool {
    bytes.len() >= 8 && bytes[..8] == PNG_MAGIC
}

/// Minimal URL-encoding for game names in thumbnail URLs.
///
/// RetroArch thumbnail filenames use standard URL encoding for
/// special characters in game names. This encodes spaces and
/// common punctuation that appear in DAT game names.
fn urlencoding(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for byte in s.bytes() {
        match byte {
            b' ' => out.push_str("%20"),
            b'(' => out.push_str("%28"),
            b')' => out.push_str("%29"),
            b'&' => out.push_str("%26"),
            b'\'' => out.push_str("%27"),
            b'#' => out.push_str("%23"),
            b'+' => out.push_str("%2B"),
            b',' => out.push_str("%2C"),
            b':' => out.push_str("%3A"),
            b'!' => out.push_str("%21"),
            // Common safe characters
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9'
            | b'-' | b'_' | b'.' | b'~' => out.push(byte as char),
            // Encode everything else
            _ => out.push_str(&format!("%{:02X}", byte)),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_thumbnail_url_encodes_spaces_and_parens() {
        let url = build_thumbnail_url(
            "Nintendo - Super Nintendo Entertainment System",
            "Super Mario World (USA)",
        );
        assert_eq!(
            url,
            "https://thumbnails.libretro.com/Nintendo - Super Nintendo Entertainment System/Named_Boxarts/Super%20Mario%20World%20%28USA%29.png"
        );
    }

    #[test]
    fn build_thumbnail_url_simple_name() {
        let url = build_thumbnail_url(
            "Nintendo - Game Boy Advance",
            "Pokemon - Emerald Version",
        );
        assert!(url.contains("Pokemon%20-%20Emerald%20Version"));
        assert!(url.starts_with("https://thumbnails.libretro.com/"));
    }

    #[test]
    fn valid_png_magic() {
        let png = vec![0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00];
        assert!(is_valid_png(&png));
    }

    #[test]
    fn invalid_png_too_short() {
        assert!(!is_valid_png(&[0x89, 0x50]));
    }

    #[test]
    fn invalid_png_wrong_magic() {
        let jpg = vec![0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46];
        assert!(!is_valid_png(&jpg));
    }

    #[test]
    fn urlencoding_spaces() {
        assert_eq!(urlencoding("hello world"), "hello%20world");
    }

    #[test]
    fn urlencoding_parens() {
        assert_eq!(urlencoding("(USA)"), "%28USA%29");
    }

    #[test]
    fn urlencoding_ampersand() {
        assert_eq!(urlencoding("Dungeons & Dragons"), "Dungeons%20%26%20Dragons");
    }
}
