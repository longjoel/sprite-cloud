//! Durable per-game DAT verification state, keyed by opaque local game ID.
//!
//! Mirrors `library_state` semantics: a JSON file on disk, written
//! atomically (temp file + rename + fsync) with rollback on failure.
//! Survives rescan, server reconnect, and restart — the catalog sync
//! attaches this to every synced game so sc-web can persist and display it.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::io::{self, Write};
use std::path::{Path, PathBuf};

/// DAT verification state of a game.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum VerificationState {
    /// DAT match — canonical identity is trustworthy.
    Verified,
    /// DAT loaded but no match — still playable, visibly unverified.
    Unverified,
    /// No DAT evidence (no catalog, or not a ROM).
    #[default]
    None,
}

/// Canonical identity + provenance recorded when a file is enriched.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub(crate) struct GameVerification {
    pub state: VerificationState,
    pub canonical_title: Option<String>,
    pub canonical_platform: Option<String>,
    pub region: Option<String>,
    pub revision: Option<String>,
    /// Match confidence: "sha1" or "crc32_size"
    pub confidence: Option<String>,
    pub catalog_name: Option<String>,
    pub catalog_version: Option<String>,
    pub catalog_sha256: Option<String>,
    /// Original filename at enrichment time.
    pub source_name: Option<String>,
    /// ISO-8601 timestamp of the enrichment.
    pub enriched_at: Option<String>,
}

impl GameVerification {
    /// Build verification evidence from a computed+enriched manifest.
    pub(crate) fn from_manifest(
        manifest: &crate::rom_transfer::staging::AssetManifest,
        source_name: &str,
    ) -> Self {
        use crate::rom_transfer::staging::Classification;

        let (state, dat) = match manifest.classification {
            Classification::RomVerified => {
                (VerificationState::Verified, manifest.dat_match.as_ref())
            }
            Classification::Unverified => (VerificationState::Unverified, None),
            _ => (VerificationState::None, None),
        };

        Self {
            state,
            canonical_title: dat.map(|d| d.canonical_name.clone()),
            canonical_platform: dat.and_then(|d| d.platform.clone()),
            region: dat.and_then(|d| d.region.clone()),
            revision: dat.and_then(|d| d.revision.clone()),
            confidence: dat.map(|d| d.confidence.clone()),
            catalog_name: dat.and_then(|d| d.catalog_name.clone()),
            catalog_version: dat.and_then(|d| d.catalog_version.clone()),
            catalog_sha256: dat.and_then(|d| d.catalog_sha256.clone()),
            source_name: Some(source_name.to_string()),
            enriched_at: Some(now_iso8601()),
        }
    }
}

fn now_iso8601() -> String {
    time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_else(|_| "unknown".to_string())
}

/// Durable store of per-game verification evidence.
pub(crate) struct VerificationStore {
    path: PathBuf,
    state: BTreeMap<String, GameVerification>,
}

impl VerificationStore {
    pub fn load(path: PathBuf) -> io::Result<Self> {
        let state = if path.exists() {
            let data = std::fs::read(&path)?;
            match serde_json::from_slice::<BTreeMap<String, GameVerification>>(&data) {
                Ok(state) => state,
                Err(error) => {
                    // A corrupt state file must never brick startup: verification
                    // evidence is derived data (worst case: badges come back on
                    // the next commit). Degrade to empty with a loud warning.
                    tracing::warn!(
                        "verification state at {} is corrupt ({error}); starting with no evidence",
                        path.display()
                    );
                    BTreeMap::new()
                }
            }
        } else {
            BTreeMap::new()
        };
        Ok(Self { path, state })
    }

    pub fn get(&self, game_id: &str) -> Option<&GameVerification> {
        self.state.get(game_id)
    }

    pub fn snapshot(&self) -> BTreeMap<String, GameVerification> {
        self.state.clone()
    }

    /// Record or replace verification evidence for a game (atomic write).
    pub fn record(&mut self, game_id: String, verification: GameVerification) -> io::Result<()> {
        self.mutate(|state| {
            state.insert(game_id, verification);
        })
    }

    /// Drop evidence for a game that no longer exists (atomic write).
    pub fn remove(&mut self, game_id: &str) -> io::Result<()> {
        self.mutate(|state| {
            state.remove(game_id);
        })
    }

    fn mutate<T>(
        &mut self,
        update: impl FnOnce(&mut BTreeMap<String, GameVerification>) -> T,
    ) -> io::Result<T> {
        let before = self.state.clone();
        let result = update(&mut self.state);
        if let Err(error) = write_state(&self.path, &self.state) {
            self.state = before;
            return Err(error);
        }
        Ok(result)
    }
}

pub fn state_path() -> PathBuf {
    if let Some(path) = std::env::var_os("GV_VERIFICATION_STATE_PATH") {
        return PathBuf::from(path);
    }
    if let Some(data_dir) = std::env::var_os("GV_DATA_DIR") {
        return PathBuf::from(data_dir).join("verification-state.json");
    }
    let mut path = dirs::data_local_dir().unwrap_or_else(|| PathBuf::from("."));
    path.push("sprite-cloud");
    path.push("verification-state.json");
    path
}

fn write_state(path: &Path, state: &BTreeMap<String, GameVerification>) -> io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let data = serde_json::to_vec_pretty(state)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
    let temp = path.with_extension(format!("json.tmp-{}", std::process::id()));
    let result = (|| {
        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .truncate(true)
            .write(true)
            .open(&temp)?;
        file.write_all(&data)?;
        file.sync_all()?;
        drop(file);
        std::fs::rename(&temp, path)?;
        if let Some(parent) = path.parent() {
            let dir = std::fs::File::open(parent)?;
            dir.sync_all()?;
        }
        Ok(())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temp);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn store_round_trips_across_reload() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("verification-state.json");

        let mut store = VerificationStore::load(path.clone()).unwrap();
        store
            .record(
                "local_abc".into(),
                GameVerification {
                    state: VerificationState::Verified,
                    canonical_title: Some("Super Mario World (USA)".into()),
                    canonical_platform: Some("SNES".into()),
                    region: Some("USA".into()),
                    revision: None,
                    confidence: Some("sha1".into()),
                    catalog_name: Some("Test DAT".into()),
                    catalog_version: Some("20240115".into()),
                    catalog_sha256: Some("cafe".into()),
                    source_name: Some("smw.sfc".into()),
                    enriched_at: Some("2026-01-01T00:00:00Z".into()),
                },
            )
            .unwrap();

        let reloaded = VerificationStore::load(path).unwrap();
        let v = reloaded.get("local_abc").expect("recorded");
        assert_eq!(v.state, VerificationState::Verified);
        assert_eq!(
            v.canonical_title.as_deref(),
            Some("Super Mario World (USA)")
        );
        assert_eq!(v.catalog_sha256.as_deref(), Some("cafe"));
    }

    #[test]
    fn corrupt_state_file_degrades_to_empty_not_error() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("verification-state.json");
        std::fs::write(&path, b"{ this is not valid json !!!").unwrap();

        let store = VerificationStore::load(path).unwrap();
        assert!(store.snapshot().is_empty(), "corrupt state starts empty");
        // And the store remains usable afterwards.
        let mut store = store;
        store
            .record(
                "local_abc".into(),
                GameVerification {
                    state: VerificationState::Unverified,
                    ..Default::default()
                },
            )
            .unwrap();
        assert!(store.get("local_abc").is_some());
    }

    #[test]
    fn store_remove_and_missing() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("verification-state.json");
        let mut store = VerificationStore::load(path.clone()).unwrap();
        store
            .record(
                "local_x".into(),
                GameVerification {
                    state: VerificationState::Unverified,
                    ..Default::default()
                },
            )
            .unwrap();
        store.remove("local_x").unwrap();
        let reloaded = VerificationStore::load(path).unwrap();
        assert!(reloaded.get("local_x").is_none());
    }

    #[test]
    fn from_manifest_maps_verified_state_and_provenance() {
        let manifest = crate::rom_transfer::staging::AssetManifest {
            sha256: "0".repeat(64),
            sha1: "1".repeat(40),
            crc32: "2".repeat(8),
            size: 42,
            extension: Some("sfc".into()),
            classification: crate::rom_transfer::staging::Classification::RomVerified,
            dat_match: Some(crate::rom_transfer::staging::DatMatchInfo {
                canonical_name: "Super Mario World (USA)".into(),
                platform: Some("SNES".into()),
                region: Some("USA".into()),
                revision: Some("Rev 1".into()),
                confidence: "sha1".into(),
                catalog_name: Some("Test DAT".into()),
                catalog_version: Some("20240115".into()),
                catalog_sha256: Some("cafe".into()),
            }),
            bios_match: None,
        };

        let v = GameVerification::from_manifest(&manifest, "smw.sfc");
        assert_eq!(v.state, VerificationState::Verified);
        assert_eq!(
            v.canonical_title.as_deref(),
            Some("Super Mario World (USA)")
        );
        assert_eq!(v.revision.as_deref(), Some("Rev 1"));
        assert_eq!(v.source_name.as_deref(), Some("smw.sfc"));
        assert!(v.enriched_at.is_some());
    }

    #[test]
    fn from_manifest_maps_unverified_and_ignores_bios() {
        let mut manifest = crate::rom_transfer::staging::AssetManifest {
            sha256: "0".repeat(64),
            sha1: "1".repeat(40),
            crc32: "2".repeat(8),
            size: 42,
            extension: Some("sfc".into()),
            classification: crate::rom_transfer::staging::Classification::Unverified,
            dat_match: None,
            bios_match: None,
        };
        let v = GameVerification::from_manifest(&manifest, "unknown.sfc");
        assert_eq!(v.state, VerificationState::Unverified);

        manifest.classification = crate::rom_transfer::staging::Classification::Bios;
        let v = GameVerification::from_manifest(&manifest, "bios.bin");
        assert_eq!(v.state, VerificationState::None);
    }
}
