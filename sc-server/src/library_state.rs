//! Durable server-wide library preferences keyed by opaque local game ID.

use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::io::{self, Write};
use std::path::{Path, PathBuf};

pub const MAX_PINS: usize = 20;

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default)]
pub struct LibraryPreferences {
    pub version: u32,
    pub favorites: BTreeSet<String>,
    pub pins: Vec<String>,
    pub names: BTreeMap<String, String>,
    pub recent: BTreeMap<String, String>,
}

impl LibraryPreferences {
    fn normalize(&mut self) {
        if self.version == 0 {
            self.version = 1;
        }
        self.pins.truncate(MAX_PINS);
        let mut seen = BTreeSet::new();
        self.pins.retain(|id| seen.insert(id.clone()));
    }

    pub fn is_favorite(&self, game_id: &str) -> bool {
        self.favorites.contains(game_id)
    }

    pub fn is_pinned(&self, game_id: &str) -> bool {
        self.pins.iter().any(|id| id == game_id)
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
        state.normalize();
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

    pub fn toggle_pin(&mut self, game_id: &str) -> io::Result<Result<bool, &'static str>> {
        self.mutate(|state| {
            if let Some(index) = state.pins.iter().position(|id| id == game_id) {
                state.pins.remove(index);
                Ok(false)
            } else if state.pins.len() >= MAX_PINS {
                Err("pin limit reached")
            } else {
                state.pins.push(game_id.to_string());
                Ok(true)
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
        assert_eq!(store.toggle_pin("local_a").unwrap(), Ok(true));
        store.rename("local_a", "My Game").unwrap();
        store
            .record_played("local_a", "2026-07-23T22:00:00Z")
            .unwrap();

        let reloaded = LibraryStateStore::load(path).unwrap().snapshot();
        assert!(reloaded.is_favorite("local_a"));
        assert!(reloaded.is_pinned("local_a"));
        assert_eq!(reloaded.names.get("local_a").unwrap(), "My Game");
        assert_eq!(
            reloaded.recent.get("local_a").unwrap(),
            "2026-07-23T22:00:00Z"
        );
    }

    #[test]
    fn pin_limit_is_enforced_without_losing_existing_pins() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("library-state.json");
        let mut store = LibraryStateStore::load(path).unwrap();
        for index in 0..MAX_PINS {
            assert_eq!(
                store.toggle_pin(&format!("local_{index:032x}")).unwrap(),
                Ok(true)
            );
        }

        assert_eq!(
            store
                .toggle_pin("local_ffffffffffffffffffffffffffffffff")
                .unwrap(),
            Err("pin limit reached")
        );
        assert_eq!(store.snapshot().pins.len(), MAX_PINS);
    }
}
