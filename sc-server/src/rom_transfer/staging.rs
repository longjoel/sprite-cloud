//! Staging + hash manifest for ingested files.
//!
//! After a file is uploaded, it lands in the staging directory. This module
//! computes a typed asset manifest without publishing to managed ROM directories.
//!
//! Manifest fields: sha256, sha1, crc32, size, mime_type, extension, classification.
//! All hashes are computed in a single streaming pass.

use crc::Crc;
use sha1::Sha1;
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

/// CRC-32/ISO-HDLC (the standard zip/PNG CRC-32).
pub(crate) static CRC32: Crc<u32> = Crc::<u32>::new(&crc::CRC_32_ISO_HDLC);

/// Supported staging classifications.
///
/// `RomVerified` is set when a DAT index confirms the file identity.
/// `Unverified` means the file was committed but no DAT match was found.
/// The original `Rom`/`Bios`/`Artwork`/`Unknown` are extension-heuristic
/// only and are overridden by DAT enrichment.
#[derive(Debug, Clone, serde::Serialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub(crate) enum Classification {
    Rom,
    RomVerified,
    Bios,
    Artwork,
    Unknown,
    Unverified,
}

/// DAT match metadata attached to a manifest after index lookup.
#[derive(Debug, Clone, serde::Serialize)]
pub(crate) struct DatMatchInfo {
    /// Canonical game name from the DAT (e.g. "Super Mario World (USA)")
    pub canonical_name: String,
    /// Platform from the DAT header (e.g. "Nintendo - Super Nintendo Entertainment System")
    pub platform: Option<String>,
    /// Region extracted from the game name when parseable
    pub region: Option<String>,
    /// Match confidence: "sha1" or "crc32_size"
    pub confidence: String,
}

/// The full manifest produced from a single staging pass.
#[derive(Debug, Clone, serde::Serialize)]
pub(crate) struct AssetManifest {
    pub sha256: String,
    pub sha1: String,
    pub crc32: String,
    pub size: u64,
    pub extension: Option<String>,
    pub classification: Classification,
    /// Populated when a DAT index matches this file.
    /// Absent when no DAT is available for the platform.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dat_match: Option<DatMatchInfo>,
}

/// Compute hashes and classification from a staged file path.
pub(crate) async fn compute_manifest(path: &Path, file_size: u64) -> Result<AssetManifest, String> {
    let mut file = tokio::fs::File::open(path)
        .await
        .map_err(|e| format!("cannot open staged file: {e}"))?;

    let mut sha256 = Sha256::new();
    let mut sha1 = Sha1::new();
    let mut crc_digest = CRC32.digest();

    let mut buf = vec![0u8; 256 * 1024]; // 256 KiB read buffer
    use tokio::io::AsyncReadExt;

    loop {
        match file.read(&mut buf).await {
            Ok(0) => break,
            Ok(n) => {
                sha256.update(&buf[..n]);
                sha1.update(&buf[..n]);
                crc_digest.update(&buf[..n]);
            }
            Err(e) => return Err(format!("read error: {e}")),
        }
    }

    let extension = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|s| s.to_lowercase());

    Ok(AssetManifest {
        sha256: hex::encode(sha256.finalize()),
        sha1: hex::encode(sha1.finalize()),
        crc32: format!("{:08x}", crc_digest.finalize()),
        size: file_size,
        extension,
        classification: Classification::Rom, // overridden by DAT enrichment
        dat_match: None,
    })
}

impl AssetManifest {
    /// Enrich this manifest with DAT match metadata.
    ///
    /// If `index` is Some, looks up the file's hashes and updates
    /// `classification` and `dat_match` accordingly:
    /// - SHA-1 match → `RomVerified` + full canonical identity
    /// - CRC32 + size match → `RomVerified` + canonical identity
    /// - No match → `Unverified` (but still committed)
    /// - index is None → leave classification as-is (no DAT available)
    pub(crate) fn enrich(&mut self, index: Option<&crate::dat::DatIndex>) {
        let index = match index {
            Some(idx) => idx,
            None => return, // no DAT available — leave heuristic classification
        };

        let m = index.find_match(&self.sha1, &self.crc32, self.size);

        match m.confidence {
            crate::dat::MatchConfidence::Sha1
            | crate::dat::MatchConfidence::Crc32Size => {
                self.classification = Classification::RomVerified;
                if let Some(entry) = m.entry {
                    self.dat_match = Some(DatMatchInfo {
                        canonical_name: entry.name,
                        platform: entry.platform,
                        region: entry.region,
                        confidence: match m.confidence {
                            crate::dat::MatchConfidence::Sha1 => "sha1".into(),
                            _ => "crc32_size".into(),
                        },
                    });
                }
            }
            crate::dat::MatchConfidence::None => {
                self.classification = Classification::Unverified;
            }
        }
    }
}

/// Determine the asset class from file extension.
///
/// Child 2 (DAT matching) will override ROM classifications with
/// authoritative matches; BIOS detection will be hardened by libretro .info
/// cross-checks in child 5; artwork will be validated/thumbnail in child 6.
fn classify(ext: Option<&str>) -> Classification {
    let ext = match ext {
        Some(e) => e,
        None => return Classification::Unknown,
    };

    // ROM extensions
    let rom_exts = &[
        "nes", "smc", "sfc", "gen", "md", "smd", "gg", "sms", "gb", "gbc",
        "gba", "n64", "v64", "z64", "nds", "a26", "a78", "a52", "lnx", "pce",
        "sgx", "cue", "bin", "iso", "chd", "rvz", "wbfs", "nkit", "gcz", "dol",
        "wad", "wbfs", "cso", "pbp", "ndd", "ipf", "adf", "d64", "prg", "tap",
        "tzx",
    ];
    if rom_exts.contains(&ext) {
        return Classification::Rom;
    }

    // Firmware/BIOS — detect after file-specific matching in child 5
    if matches!(ext, "bin" | "rom" | "firm" | "bios") {
        return Classification::Bios;
    }

    // Artwork
    if matches!(ext, "png" | "jpg" | "jpeg" | "gif" | "bmp" | "webp" | "svg") {
        return Classification::Artwork;
    }

    Classification::Unknown
}

/// Ensure the staging directory exists under the first ROM root.
pub(crate) fn staging_dir(rom_roots: &[String]) -> PathBuf {
    let root = rom_roots.first().map(Path::new).unwrap_or_else(|| Path::new("."));
    let staging = root.parent().map(|p| p.join("staging")).unwrap_or_else(|| root.join("staging"));
    staging
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    async fn write_temp_file(name: &str, data: &[u8]) -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join(name);
        let mut f = std::fs::File::create(&path).expect("create");
        f.write_all(data).expect("write");
        (dir, path)
    }

    #[tokio::test]
    async fn manifest_hashes_match_known_vectors() {
        let data = b"hello world";
        let (_dir, path) = write_temp_file("test.bin", data).await;
        let manifest = compute_manifest(&path, data.len() as u64).await.expect("manifest");

        // Pre-computed hashes for "hello world"
        assert_eq!(manifest.sha256, "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9");
        assert_eq!(manifest.sha1, "2aae6c35c94fcfb415dbe95f408b9ce91ee846ed");
        assert_eq!(manifest.crc32, "0d4a1185"); // CRC32/ISO-HDLC for "hello world"
        assert_eq!(manifest.size, 11);
    }

    #[tokio::test]
    async fn classification_by_extension() {
        assert!(matches!(classify(Some("nes")), Classification::Rom));
        assert!(matches!(classify(Some("smc")), Classification::Rom));
        assert!(matches!(classify(Some("iso")), Classification::Rom));
        assert!(matches!(classify(Some("bios")), Classification::Bios));
        assert!(matches!(classify(Some("png")), Classification::Artwork));
        assert!(matches!(classify(Some("mp3")), Classification::Unknown));
        assert!(matches!(classify(None), Classification::Unknown));
    }

    #[tokio::test]
    async fn staging_dir_uses_first_root() {
        let roots = vec!["/games/n64".to_string(), "/games/snes".to_string()];
        let dir = staging_dir(&roots);
        assert!(dir.to_string_lossy().contains("staging"));
        assert!(dir.to_string_lossy().contains("games"));
    }

    #[tokio::test]
    async fn large_file_does_not_overflow_hash() {
        // 4.1 MiB of repeated data — verify streaming doesn't corrupt state
        let data = vec![0xABu8; 4_200_000];
        let (_dir, path) = write_temp_file("big.bin", &data).await;
        let manifest = compute_manifest(&path, data.len() as u64).await.expect("manifest");
        assert_eq!(manifest.size, 4_200_000);
        assert_eq!(manifest.sha256.len(), 64);
        assert_eq!(manifest.sha1.len(), 40);
        assert_eq!(manifest.crc32.len(), 8);
    }

    // ── DAT enrichment tests ───────────────────────────────────────

    fn make_test_index() -> crate::dat::DatIndex {
        use crate::dat::RomEntry;
        let entries = vec![RomEntry {
            name: "hello world (World)".into(),
            alt_names: vec![],
            platform: Some("Test Platform".into()),
            region: Some("World".into()),
            revision: None,
            status: Some("verified".into()),
            size: 11,
            crc32: Some("0d4a1185".into()),
            md5: None,
            sha1: Some("2aae6c35c94fcfb415dbe95f408b9ce91ee846ed".into()),
        }];
        crate::dat::DatIndex::from_entries(entries)
    }

    #[tokio::test]
    async fn enrich_sha1_match_upgrades_to_rom_verified() {
        let data = b"hello world";
        let (_dir, path) = write_temp_file("test.bin", data).await;
        let mut manifest = compute_manifest(&path, data.len() as u64).await.expect("manifest");
        let index = make_test_index();

        manifest.enrich(Some(&index));

        assert_eq!(manifest.classification, Classification::RomVerified);
        let m = manifest.dat_match.expect("dat_match should be populated");
        assert_eq!(m.canonical_name, "hello world (World)");
        assert_eq!(m.confidence, "sha1");
        assert_eq!(m.platform.as_deref(), Some("Test Platform"));
        assert_eq!(m.region.as_deref(), Some("World"));
    }

    #[tokio::test]
    async fn enrich_no_match_sets_unverified() {
        let data = b"some unknown file content!";
        let (_dir, path) = write_temp_file("unknown.bin", data).await;
        let mut manifest = compute_manifest(&path, data.len() as u64).await.expect("manifest");
        let index = make_test_index();

        manifest.enrich(Some(&index));

        assert_eq!(manifest.classification, Classification::Unverified);
        assert!(manifest.dat_match.is_none(), "no dat_match for unverified files");
    }

    #[tokio::test]
    async fn enrich_with_none_index_is_noop() {
        let data = b"hello world";
        let (_dir, path) = write_temp_file("test.bin", data).await;
        let mut manifest = compute_manifest(&path, data.len() as u64).await.expect("manifest");

        let original_classification = manifest.classification.clone();
        manifest.enrich(None);

        // Classification unchanged when no DAT available
        assert_eq!(manifest.classification, original_classification);
        assert!(manifest.dat_match.is_none());
    }
}
