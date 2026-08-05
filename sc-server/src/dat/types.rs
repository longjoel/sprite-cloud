//! DAT types — ROM records, index entries, and provenance metadata.
//!
//! These types represent the parsed and indexed output of a DAT file
//! (No-Intro / Logiqx XML or Redump). The parser normalises all formats
//! into these common structures.

use std::collections::HashMap;

/// A single ROM/game record from a DAT file.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct RomEntry {
    /// Canonical game name (e.g. "Super Mario World (USA)")
    pub name: String,
    /// Known alternate names / titles
    pub alt_names: Vec<String>,
    /// Platform / system (e.g. "Nintendo - Super Nintendo Entertainment System")
    pub platform: Option<String>,
    /// Region tag when present (e.g. "USA", "Japan", "Europe")
    pub region: Option<String>,
    /// Revision / version string
    pub revision: Option<String>,
    /// Dump status: "verified", "good", "baddump", etc.
    pub status: Option<String>,
    /// Expected file size in bytes
    pub size: u64,
    /// CRC32 hex string (lowercase, 8 chars)
    pub crc32: Option<String>,
    /// MD5 hex string (lowercase, 32 chars) — present in some DATs
    pub md5: Option<String>,
    /// SHA-1 hex string (lowercase, 40 chars) — present in most DATs
    pub sha1: Option<String>,
}

/// Immutable DAT index keyed by hash for O(1) lookup.
///
/// Primary lookup: SHA-1 → Vec<&RomEntry> (rarely multiple entries)
/// Secondary lookup: (CRC32, size) → Vec<&RomEntry>
///
/// The index stores owned entries; lookups return references.
#[derive(Debug, Clone, Default)]
pub(crate) struct DatIndex {
    entries: Vec<RomEntry>,
    by_sha1: HashMap<String, Vec<usize>>,
    by_crc32_size: HashMap<(String, u64), Vec<usize>>,
    /// Parallel to `entries`: index of the source catalog (into the
    /// owning catalog's `sources`) each entry came from.
    entry_source: Vec<usize>,
}

/// Information about the source DAT file.
#[derive(Debug, Clone)]
pub(crate) struct DatProvenance {
    /// Source filename (e.g. "Nintendo - Super NES (2024-01-15).dat")
    pub source_name: Option<String>,
    /// DAT name/header (e.g. "Nintendo - Super Nintendo Entertainment System")
    pub dat_name: Option<String>,
    /// DAT description
    pub description: Option<String>,
    /// Version string from DAT header
    pub version: Option<String>,
    /// Date string from DAT header
    pub date: Option<String>,
    /// Author / clrmamepro header
    pub author: Option<String>,
    /// URL from DAT header
    pub url: Option<String>,
    /// When this DAT was imported
    pub imported_at: String,
    /// SHA-256 of the raw DAT file bytes
    pub source_sha256: Option<String>,
    /// Total game entries parsed
    pub entry_count: usize,
}

/// Result of parsing a DAT file.
#[derive(Debug, Clone)]
pub(crate) struct ParseResult {
    pub provenance: DatProvenance,
    pub index: DatIndex,
}

/// Confidence level for a ROM match.
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum MatchConfidence {
    /// Exact SHA-1 match — highest confidence
    Sha1,
    /// CRC32 + size match — strong but not cryptographic
    Crc32Size,
    /// No match in any loaded DAT
    None,
}

/// The result of looking up a staged file against the DAT index.
#[derive(Debug, Clone)]
pub(crate) struct DatMatch {
    /// Matching ROM entry if found
    pub entry: Option<RomEntry>,
    /// How the match was made
    pub confidence: MatchConfidence,
    /// Human-readable provenance string (e.g. "Exact SHA-1 match")
    pub provenance: String,
    /// Index of the source catalog this entry came from (into the owning
    /// catalog's `sources`). `None` when there was no match.
    pub source: Option<usize>,
}

impl DatIndex {
    /// Build an index from parsed entries.
    pub(crate) fn from_entries(entries: Vec<RomEntry>) -> Self {
        let entry_count = entries.len();
        let mut by_sha1: HashMap<String, Vec<usize>> = HashMap::new();
        let mut by_crc32_size: HashMap<(String, u64), Vec<usize>> = HashMap::new();

        for (i, entry) in entries.iter().enumerate() {
            if let Some(ref sha1) = entry.sha1 {
                by_sha1.entry(sha1.clone()).or_default().push(i);
            }
            if let Some(ref crc32) = entry.crc32 {
                by_crc32_size
                    .entry((crc32.clone(), entry.size))
                    .or_default()
                    .push(i);
            }
        }

        DatIndex {
            entries,
            by_sha1,
            by_crc32_size,
            entry_source: vec![0; entry_count],
        }
    }

    /// Build an index from (entry, source-catalog-index) pairs, recording
    /// which source catalog each entry belongs to.
    pub(crate) fn from_sourced_entries(entries: Vec<(RomEntry, usize)>) -> Self {
        let mut roms = Vec::with_capacity(entries.len());
        let mut sources = Vec::with_capacity(entries.len());
        for (entry, source) in entries {
            roms.push(entry);
            sources.push(source);
        }
        let mut index = DatIndex::from_entries(roms);
        index.entry_source = sources;
        index
    }

    /// Look up by SHA-1 hash.
    pub(crate) fn find_by_sha1(&self, sha1: &str) -> Vec<&RomEntry> {
        self.by_sha1
            .get(sha1)
            .map(|indices| indices.iter().map(|&i| &self.entries[i]).collect())
            .unwrap_or_default()
    }

    /// Look up by CRC32 + size.
    pub(crate) fn find_by_crc32_size(&self, crc32: &str, size: u64) -> Vec<&RomEntry> {
        self.by_crc32_size
            .get(&(crc32.to_string(), size))
            .map(|indices| indices.iter().map(|&i| &self.entries[i]).collect())
            .unwrap_or_default()
    }

    /// Full match: try SHA-1 first, fall back to CRC32+size, return best result.
    pub(crate) fn find_match(&self, sha1: &str, crc32: &str, size: u64) -> DatMatch {
        // Prefer SHA-1 exact match
        if let Some(&i) = self.by_sha1.get(sha1).and_then(|indices| indices.first()) {
            return DatMatch {
                entry: Some(self.entries[i].clone()),
                confidence: MatchConfidence::Sha1,
                provenance: "Exact SHA-1 match".to_string(),
                source: Some(self.entry_source[i]),
            };
        }

        // Fall back to CRC32 + size
        if let Some(&i) = self
            .by_crc32_size
            .get(&(crc32.to_string(), size))
            .and_then(|indices| indices.first())
        {
            return DatMatch {
                entry: Some(self.entries[i].clone()),
                confidence: MatchConfidence::Crc32Size,
                provenance: "CRC32 + size match".to_string(),
                source: Some(self.entry_source[i]),
            };
        }

        DatMatch {
            entry: None,
            confidence: MatchConfidence::None,
            provenance: "No DAT match; extension heuristic only".to_string(),
            source: None,
        }
    }

    /// Number of indexed entries.
    pub(crate) fn len(&self) -> usize {
        self.entries.len()
    }

    /// True if the index is empty.
    #[allow(dead_code)]
    pub(crate) fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// Iterate over all entries.
    #[allow(dead_code)]
    pub(crate) fn entries(&self) -> impl Iterator<Item = &RomEntry> {
        self.entries.iter()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_entry(name: &str, sha1: &str, crc32: &str, size: u64) -> RomEntry {
        RomEntry {
            name: name.to_string(),
            alt_names: vec![],
            platform: Some("Test Platform".to_string()),
            region: Some("USA".to_string()),
            revision: None,
            status: Some("verified".to_string()),
            size,
            crc32: Some(crc32.to_string()),
            md5: None,
            sha1: Some(sha1.to_string()),
        }
    }

    #[test]
    fn sha1_exact_match() {
        let entries = vec![
            make_entry("Game A", "aaaa", "11111111", 1024),
            make_entry("Game B", "bbbb", "22222222", 2048),
        ];
        let index = DatIndex::from_entries(entries);

        let result = index.find_match("aaaa", "11111111", 1024);
        assert_eq!(result.confidence, MatchConfidence::Sha1);
        assert_eq!(result.entry.unwrap().name, "Game A");
        assert_eq!(result.provenance, "Exact SHA-1 match");
    }

    #[test]
    fn crc32_size_fallback() {
        let entries = vec![make_entry("Game B", "bbbb", "22222222", 2048)];
        let index = DatIndex::from_entries(entries);

        // SHA-1 doesn't match, but CRC32+size does
        let result = index.find_match("wrong_sha1", "22222222", 2048);
        assert_eq!(result.confidence, MatchConfidence::Crc32Size);
        assert_eq!(result.entry.unwrap().name, "Game B");
    }

    #[test]
    fn no_match() {
        let entries = vec![make_entry("Game A", "aaaa", "11111111", 1024)];
        let index = DatIndex::from_entries(entries);

        let result = index.find_match("xxxx", "99999999", 9999);
        assert_eq!(result.confidence, MatchConfidence::None);
        assert!(result.entry.is_none());
        assert!(result.provenance.contains("No DAT match"));
    }

    #[test]
    fn sha1_priority_over_crc32() {
        // Two entries: one matches SHA-1, one matches CRC32+size
        let entries = vec![
            make_entry("Correct Game", "aaaa", "11111111", 1024),
            make_entry("Wrong CRC Match", "bbbb", "11111111", 1024),
        ];
        let index = DatIndex::from_entries(entries);

        // SHA-1 "aaaa" picks first entry even though CRC32 matches both
        let result = index.find_match("aaaa", "11111111", 1024);
        assert_eq!(result.confidence, MatchConfidence::Sha1);
        assert_eq!(result.entry.unwrap().name, "Correct Game");
    }
}
