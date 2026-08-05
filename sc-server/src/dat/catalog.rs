//! DAT catalog loading — resolve configured catalog paths and build the
//! bounded, immutable aggregate index consumed by `stage_rom`.
//!
//! ## Reload semantics
//!
//! `load_catalog` is best-effort at the file level: every parseable file is
//! merged into the aggregate index and every rejected file is reported in
//! `CatalogLoad::failures` (filename + reason only — never catalog contents
//! or private ROM paths). A SIGHUP-triggered reload treats ANY failure as a
//! rejection of the whole replacement so the last known-good index survives
//! atomically; see the reload task in `commands/mod.rs`.

use std::collections::HashSet;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use crate::config;
use crate::dat::parser::parse_dat;
use crate::dat::types::{DatIndex, DatProvenance, RomEntry};

/// Hard cap on the number of catalog files loaded per index (dir + files).
const MAX_CATALOG_FILES: usize = 256;
/// Hard cap on total ROM entries across all loaded catalogs.
const MAX_TOTAL_ENTRIES: usize = 2_000_000;

/// A successfully loaded catalog set: one aggregate index plus the
/// provenance record of every source file (for identity logging).
#[derive(Debug, Clone)]
pub(crate) struct LoadedCatalog {
    pub index: DatIndex,
    pub sources: Vec<DatProvenance>,
}

/// Result of a catalog load attempt.
#[derive(Debug, Default)]
pub(crate) struct CatalogLoad {
    /// Aggregate index over every successfully parsed catalog file.
    /// `None` when no file parsed (or nothing was configured).
    pub catalog: Option<LoadedCatalog>,
    /// (display name, reason) pairs for rejected files — filenames only,
    /// never full paths or catalog contents.
    pub failures: Vec<(String, String)>,
}

/// Configured catalog paths, plus any path-resolution failures
/// (e.g. a configured directory that does not exist).
#[derive(Debug, Default)]
pub(crate) struct CatalogPaths {
    pub paths: Vec<PathBuf>,
    pub failures: Vec<(String, String)>,
}

/// Resolve the configured catalog sources: a non-recursive `dir` scan
/// (sorted, `*.dat` only) followed by the explicit `files` list, deduplicated.
pub(crate) fn configured_paths(cfg: &config::Config) -> CatalogPaths {
    let mut result = CatalogPaths::default();
    let mut seen: HashSet<PathBuf> = HashSet::new();

    let Some(dat) = cfg.dat.as_ref() else {
        return result;
    };

    if let Some(dir) = dat.dir.as_ref() {
        let dir_path = Path::new(dir);
        match std::fs::read_dir(dir_path) {
            Ok(entries) => {
                let mut files: Vec<PathBuf> = entries
                    .filter_map(|e| e.ok())
                    .map(|e| e.path())
                    .filter(|p| {
                        p.extension()
                            .map(|ext| ext.eq_ignore_ascii_case("dat"))
                            .unwrap_or(false)
                    })
                    .collect();
                files.sort();
                for path in files {
                    if seen.insert(path.clone()) {
                        result.paths.push(path);
                    }
                }
            }
            Err(error) => {
                let name = dir_path
                    .file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_else(|| dir.clone());
                result
                    .failures
                    .push((name, format!("catalog directory not readable: {error}")));
            }
        }
    }

    for file in &dat.files {
        let path = PathBuf::from(file);
        if seen.insert(path.clone()) {
            result.paths.push(path);
        }
    }

    result
}

/// Parse every configured catalog file and merge the results into one
/// bounded aggregate index. Rejected files are reported in `failures`.
pub(crate) fn load_catalog(paths: &[PathBuf]) -> CatalogLoad {
    if paths.len() > MAX_CATALOG_FILES {
        return CatalogLoad {
            catalog: None,
            failures: vec![(
                "catalog set".into(),
                format!(
                    "{} configured catalogs exceed the max of {MAX_CATALOG_FILES}",
                    paths.len()
                ),
            )],
        };
    }

    let mut sources: Vec<DatProvenance> = Vec::new();
    let mut entries: Vec<RomEntry> = Vec::new();
    let mut total_entries = 0usize;
    let mut failures: Vec<(String, String)> = Vec::new();

    for path in paths {
        let name = path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| path.display().to_string());

        // Bound the read BEFORE allocation: the parser's 64 MiB document cap
        // only applies after the file is in memory, so an unbounded read of a
        // multi-GB .dat (or a symlink pointing at one) would OOM the server.
        // `take()` caps the allocation even if the file grows mid-read.
        let max_document = crate::dat::parser::ParseLimits::default().max_document_bytes;
        let file = match std::fs::File::open(path) {
            Ok(file) => file,
            Err(error) => {
                failures.push((name, format!("read failed: {error}")));
                continue;
            }
        };
        let mut data = Vec::new();
        if let Err(error) = file.take(max_document + 1).read_to_end(&mut data) {
            failures.push((name, format!("read failed: {error}")));
            continue;
        }
        if data.len() as u64 > max_document {
            failures.push((
                name,
                format!("size {} exceeds max {max_document}", data.len()),
            ));
            continue;
        }

        let parsed = match parse_dat(&data, None) {
            Ok(parsed) => parsed,
            Err(error) => {
                failures.push((name, format!("parse failed: {error}")));
                continue;
            }
        };

        let file_entries = parsed.index.len();
        if total_entries + file_entries > MAX_TOTAL_ENTRIES {
            failures.push((
                name,
                format!(
                    "{file_entries} entries would exceed the aggregate max of {MAX_TOTAL_ENTRIES}"
                ),
            ));
            continue;
        }

        entries.extend(parsed.index.entries().cloned());
        total_entries += file_entries;
        sources.push(parsed.provenance);
    }

    let catalog = if sources.is_empty() {
        None
    } else {
        Some(LoadedCatalog {
            index: DatIndex::from_entries(entries),
            sources,
        })
    };

    CatalogLoad { catalog, failures }
}

/// Load catalogs from config at startup (best-effort), log identity and
/// rejections, and return the aggregate index if any catalog loaded.
pub(crate) fn load_from_config(cfg: &config::Config) -> Option<Arc<LoadedCatalog>> {
    let gathered = configured_paths(cfg);
    let loaded = load_catalog(&gathered.paths);

    let mut failures = gathered.failures;
    failures.extend(loaded.failures);
    for (name, reason) in &failures {
        tracing::warn!("[DAT] catalog rejected: {name}: {reason}");
    }

    match loaded.catalog {
        Some(catalog) => {
            for source in &catalog.sources {
                tracing::info!(
                    "[DAT] loaded catalog: {} — {}, version {}, {} entries",
                    source.source_name.as_deref().unwrap_or("unnamed source"),
                    source.dat_name.as_deref().unwrap_or("unknown"),
                    source.version.as_deref().unwrap_or("unknown"),
                    source.entry_count,
                );
            }
            tracing::info!(
                "[DAT] aggregate index ready: {} catalog(s), {} entries",
                catalog.sources.len(),
                catalog.index.len(),
            );
            Some(Arc::new(catalog))
        }
        None => {
            tracing::info!(
                "[DAT] no DAT catalogs available — staged ROMs auto-commit without DAT identity"
            );
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE_DAT: &[u8] = br#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE datafile PUBLIC "-//Logiqx//DTD ROM Management Datafile//EN" "http://www.logiqx.com/Dats/datafile.dtd">
<datafile>
  <header>
    <name>Nintendo - Super Nintendo Entertainment System</name>
    <description>No-Intro SNES DAT</description>
    <version>20240115</version>
    <date>2024-01-15</date>
    <author>No-Intro</author>
    <url>https://no-intro.org</url>
  </header>
  <game name="Super Mario World (USA)">
    <description>Super Mario World (USA)</description>
    <rom name="Super Mario World (USA).sfc" size="524288" crc="B19ED489" md5="CDD3C8C37322978CA8669B34BDADE1C4" sha1="6B47BB75D16514B6A476AA89F3BBA4B1BC26BF7E"/>
  </game>
</datafile>"#;

    fn config_with_dat(dir: Option<&str>, files: &[&str]) -> config::Config {
        let mut cfg = config::Config {
            sc_web: config::ScWeb {
                url: "https://sprite-cloud.com".into(),
            },
            auth: config::Auth {
                api_key: String::new(),
                server_id: String::new(),
            },
            rom: None,
            cores: None,
            system: None,
            ice: None,
            dat: None,
        };
        if dir.is_some() || !files.is_empty() {
            cfg.dat = Some(config::Dat {
                dir: dir.map(str::to_string),
                files: files.iter().map(|f| (*f).to_string()).collect(),
            });
        }
        cfg
    }

    fn write(path: &Path, contents: &[u8]) {
        std::fs::write(path, contents).expect("write fixture");
    }

    #[test]
    fn configured_paths_scans_dir_sorted_then_appends_files() {
        let dir = tempfile::tempdir().unwrap();
        write(&dir.path().join("zeta.dat"), SAMPLE_DAT);
        write(&dir.path().join("alpha.dat"), SAMPLE_DAT);
        write(&dir.path().join("notes.txt"), b"not a catalog");

        let cfg = config_with_dat(Some(dir.path().to_str().unwrap()), &["/explicit/game.dat"]);
        let gathered = configured_paths(&cfg);

        assert!(gathered.failures.is_empty());
        let names: Vec<String> = gathered
            .paths
            .iter()
            .map(|p| p.file_name().unwrap().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, vec!["alpha.dat", "zeta.dat", "game.dat"]);
    }

    #[test]
    fn configured_paths_missing_dir_is_a_failure() {
        let cfg = config_with_dat(Some("/nonexistent/dats"), &[]);
        let gathered = configured_paths(&cfg);
        assert!(gathered.paths.is_empty());
        assert_eq!(gathered.failures.len(), 1);
        assert!(gathered.failures[0].0.contains("dats"));
    }

    #[test]
    fn configured_paths_deduplicates_dir_and_files() {
        let dir = tempfile::tempdir().unwrap();
        write(&dir.path().join("game.dat"), SAMPLE_DAT);
        let dir_str = dir.path().to_str().unwrap();

        let cfg = config_with_dat(
            Some(dir_str),
            &[&format!("{dir_str}/game.dat"), "/other/snes.dat"],
        );
        let gathered = configured_paths(&cfg);

        assert!(gathered.failures.is_empty());
        assert_eq!(gathered.paths.len(), 2);
    }

    #[test]
    fn load_catalog_builds_aggregate_index() {
        let dir = tempfile::tempdir().unwrap();
        write(&dir.path().join("snes.dat"), SAMPLE_DAT);
        let paths = vec![dir.path().join("snes.dat")];

        let loaded = load_catalog(&paths);
        assert!(loaded.failures.is_empty());
        let catalog = loaded.catalog.expect("catalog loads");
        assert_eq!(catalog.index.len(), 1);
        assert_eq!(catalog.sources.len(), 1);
        assert_eq!(catalog.sources[0].entry_count, 1);
        assert_eq!(
            catalog.sources[0].dat_name.as_deref(),
            Some("Nintendo - Super Nintendo Entertainment System")
        );

        // The aggregate index resolves the sample ROM by SHA-1.
        let m = catalog.index.find_match(
            "6b47bb75d16514b6a476aa89f3bba4b1bc26bf7e",
            "b19ed489",
            524288,
        );
        assert_eq!(m.entry.unwrap().name, "Super Mario World (USA)");
    }

    #[test]
    fn load_catalog_keeps_good_files_and_reports_bad_ones() {
        let dir = tempfile::tempdir().unwrap();
        write(&dir.path().join("good.dat"), SAMPLE_DAT);
        write(
            &dir.path().join("bad.dat"),
            b"<datafile><game name=\"unterminated",
        );
        let paths = vec![dir.path().join("good.dat"), dir.path().join("bad.dat")];

        let loaded = load_catalog(&paths);
        let catalog = loaded.catalog.expect("good file still loads");
        assert_eq!(catalog.index.len(), 1);
        assert_eq!(loaded.failures.len(), 1);
        assert_eq!(loaded.failures[0].0, "bad.dat");
        assert!(loaded.failures[0].1.contains("parse failed"));
    }

    #[test]
    fn load_catalog_all_rejected_is_none() {
        let dir = tempfile::tempdir().unwrap();
        write(
            &dir.path().join("bad.dat"),
            b"<datafile><game name=\"unterminated",
        );
        let paths = vec![dir.path().join("bad.dat")];

        let loaded = load_catalog(&paths);
        assert!(loaded.catalog.is_none());
        assert_eq!(loaded.failures.len(), 1);
    }

    #[test]
    fn load_catalog_missing_file_is_a_failure() {
        let paths = vec![PathBuf::from("/nonexistent/roms.dat")];
        let loaded = load_catalog(&paths);
        assert!(loaded.catalog.is_none());
        assert_eq!(loaded.failures.len(), 1);
        assert!(loaded.failures[0].1.contains("read failed"));
    }

    #[test]
    fn load_catalog_exceeding_file_cap_is_rejected() {
        let paths: Vec<PathBuf> = (0..MAX_CATALOG_FILES + 1)
            .map(|i| PathBuf::from(format!("/cap/dat-{i}.dat")))
            .collect();
        let loaded = load_catalog(&paths);
        assert!(loaded.catalog.is_none());
        assert_eq!(loaded.failures.len(), 1);
        assert!(loaded.failures[0].1.contains("exceed the max"));
    }

    #[test]
    fn load_catalog_empty_paths_is_none() {
        let loaded = load_catalog(&[]);
        assert!(loaded.catalog.is_none());
        assert!(loaded.failures.is_empty());
    }

    #[test]
    fn load_from_config_without_dat_section_is_none() {
        let cfg = config_with_dat(None, &[]);
        assert!(load_from_config(&cfg).is_none());
    }

    #[test]
    fn load_from_config_loads_configured_dir() {
        let dir = tempfile::tempdir().unwrap();
        write(&dir.path().join("snes.dat"), SAMPLE_DAT);
        let cfg = config_with_dat(Some(dir.path().to_str().unwrap()), &[]);

        let loaded = load_from_config(&cfg).expect("catalog loads");
        assert_eq!(loaded.index.len(), 1);
    }
}
