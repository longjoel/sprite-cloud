//! Durable server-wide library preferences keyed by opaque local game ID.

use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::io::{self, Write};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default)]
pub struct LibraryPreferences {
    pub version: u32,
    pub favorites: BTreeSet<String>,
    #[serde(rename = "pins", default, skip_serializing)]
    legacy_pins: Vec<String>,
    pub names: BTreeMap<String, String>,
    pub recent: BTreeMap<String, String>,
}

impl LibraryPreferences {
    fn normalize(&mut self) -> bool {
        let changed = self.version < 2 || !self.legacy_pins.is_empty();
        self.version = 2;
        self.favorites.extend(self.legacy_pins.drain(..));
        changed
    }

    pub fn is_favorite(&self, game_id: &str) -> bool {
        self.favorites.contains(game_id)
    }

    pub fn display_name<'a>(&'a self, game_id: &str, fallback: &'a str) -> &'a str {
        self.names
            .get(game_id)
            .map(String::as_str)
            .unwrap_or(fallback)
    }
}

pub struct LibraryStateStore {
    path: PathBuf,
    state: LibraryPreferences,
}

impl LibraryStateStore {
    pub fn load(path: PathBuf) -> io::Result<Self> {
        let mut state = if path.exists() {
            let data = std::fs::read(&path)?;
            serde_json::from_slice(&data)
                .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?
        } else {
            LibraryPreferences::default()
        };
        let migrated = state.normalize();
        if migrated && path.exists() {
            write_preferences(&path, &state)?;
        }
        Ok(Self { path, state })
    }

    pub fn snapshot(&self) -> LibraryPreferences {
        self.state.clone()
    }

    pub fn toggle_favorite(&mut self, game_id: &str) -> io::Result<bool> {
        self.mutate(|state| {
            if !state.favorites.remove(game_id) {
                state.favorites.insert(game_id.to_string());
                true
            } else {
                false
            }
        })
    }

    pub fn rename(&mut self, game_id: &str, name: &str) -> io::Result<()> {
        self.mutate(|state| {
            state.names.insert(game_id.to_string(), name.to_string());
        })
    }

    pub fn record_played(&mut self, game_id: &str, played_at: &str) -> io::Result<()> {
        self.mutate(|state| {
            state
                .recent
                .insert(game_id.to_string(), played_at.to_string());
        })
    }

    fn mutate<T>(&mut self, update: impl FnOnce(&mut LibraryPreferences) -> T) -> io::Result<T> {
        let before = self.state.clone();
        let result = update(&mut self.state);
        if let Err(error) = write_preferences(&self.path, &self.state) {
            self.state = before;
            return Err(error);
        }
        Ok(result)
    }
}

pub fn state_path() -> PathBuf {
    if let Some(path) = std::env::var_os("GV_LIBRARY_STATE_PATH") {
        return PathBuf::from(path);
    }
    if let Some(data_dir) = std::env::var_os("GV_DATA_DIR") {
        return PathBuf::from(data_dir).join("library-state.json");
    }
    let mut path = dirs::data_local_dir().unwrap_or_else(|| PathBuf::from("."));
    path.push("sprite-cloud");
    path.push("library-state.json");
    path
}

fn write_preferences(path: &Path, state: &LibraryPreferences) -> io::Result<()> {
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
            std::fs::File::open(parent)?.sync_all()?;
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
    fn preferences_round_trip_and_are_shared_server_wide() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("library-state.json");
        let mut store = LibraryStateStore::load(path.clone()).unwrap();

        assert!(store.toggle_favorite("local_a").unwrap());
        store.rename("local_a", "My Game").unwrap();
        store
            .record_played("local_a", "2026-07-23T22:00:00Z")
            .unwrap();

        let reloaded = LibraryStateStore::load(path).unwrap().snapshot();
        assert!(reloaded.is_favorite("local_a"));
        assert_eq!(reloaded.names.get("local_a").unwrap(), "My Game");
        assert_eq!(
            reloaded.recent.get("local_a").unwrap(),
            "2026-07-23T22:00:00Z"
        );
    }

    #[test]
    fn legacy_pins_migrate_to_favorites_and_are_removed_from_disk() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("library-state.json");
        std::fs::write(
            &path,
            r#"{"version":1,"favorites":["local_a"],"pins":["local_a","local_b"],"names":{},"recent":{}}"#,
        )
        .unwrap();

        let snapshot = LibraryStateStore::load(path.clone()).unwrap().snapshot();
        assert_eq!(
            snapshot.favorites,
            BTreeSet::from(["local_a".to_string(), "local_b".to_string()])
        );
        let persisted: serde_json::Value =
            serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
        assert!(persisted.get("pins").is_none());
        assert_eq!(persisted["version"], 2);
    }
}
