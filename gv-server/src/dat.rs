//! RetroArch DAT file fetching, caching, and ROM matching.
//!
//! DAT files are Logiqx XML format from libretro/libretro-database.
//! Example:
//! ```xml
//! <datafile>
//!   <game name="Super Mario Land 2 - 6 Golden Coins (UE) (V1.2)">
//!     <rom name="sml2.gb" size="524288" crc="7E8E1B7F"
//!          md5="3d62a90f8ba1f4c2f0d494c5f4f82a5a"
//!          sha1="1c4a4a1c1e4a9a5c7e8a7e3f4b2a7d8e9f2c1a3d"/>
//!   </game>
//! </datafile>
//! ```
//!
//! # Security
//! - System names come from `EXTENSION_MAP`, never user input.
//! - `parse_dat` validates the `<datafile>` root element —
//!   corrupt or HTML responses produce an error, not bad matches.

use anyhow::{Context, Result};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::Path;

// ── Constants ──────────────────────────────────────────────────────────

/// How long to cache a downloaded DAT file before re-fetching.
const DAT_CACHE_TTL_SECS: u64 = 86_400; // 24 hours

/// GitHub repository for RetroArch DAT files.
const DAT_BASE_URL: &str =
    "https://raw.githubusercontent.com/libretro/libretro-database/master/dat";

/// Extension map keyed by platform slug. Used to map discovered ROM files
/// to the correct DAT. Keys must match the filename in the repo without
/// the `.dat` extension (e.g. "Nintendo - Game Boy").
const DAT_SYSTEM_NAMES: &[(&str, &[&str])] = &[
    ("Nintendo - Game Boy", &["gb"]),
    ("Nintendo - Game Boy Color", &["gbc"]),
    ("Nintendo - Game Boy Advance", &["gba"]),
    ("Nintendo - Nintendo Entertainment System", &["nes", "fds"]),
    ("Nintendo - Super Nintendo Entertainment System", &["sfc", "smc"]),
    ("Nintendo - Nintendo 64", &["n64", "z64", "v64"]),
    ("Sega - Mega Drive - Genesis", &["gen", "md", "smd"]),
    ("Atari - 2600", &["a26"]),
];

// ── Public types ───────────────────────────────────────────────────────

/// One ROM entry from a DAT file.
#[derive(Debug, Clone)]
pub struct RomEntry {
    pub game_name: String,
    pub rom_name: String,
    pub size: u64,
    pub crc: String,
    pub md5: String,
    pub sha1: String,
    /// Stripped of region tags and version numbers.
    pub canonical_name: String,
}

/// In-memory lookup index for DAT entries.
///
/// Indexes by CRC32 (fast) and SHA1 (reliable). Matching prefers SHA1
/// exact match, falls back to CRC.
pub struct DatIndex {
    by_crc: HashMap<String, Vec<RomEntry>>,
    by_sha1: HashMap<String, Vec<RomEntry>>,
}

// ── Public API ─────────────────────────────────────────────────────────

/// Build a [`DatIndex`] for the platform that matches a file extension.
///
/// Fetches and caches the DAT file from GitHub if needed, then indexes
/// all entries. Returns `None` if no DAT file exists for the extension.
pub async fn load_for_extension(ext: &str, cache_dir: &Path) -> Option<DatIndex> {
    let ext = ext.to_lowercase();
    let system = DAT_SYSTEM_NAMES
        .iter()
        .find(|(_, exts)| exts.contains(&ext.as_str()))?
        .0;

    let xml = fetch_dat(system, cache_dir).await.ok()?;
    let entries = parse_dat(&xml).ok()?;
    Some(index_entries(entries))
}

/// Match a ROM file against a DAT index.
///
/// Prefers SHA1 exact match, falls back to CRC32.
pub fn match_entry<'a>(index: &'a DatIndex, crc: &str, sha1: &str) -> Option<&'a RomEntry> {
    if let Some(entries) = index.by_sha1.get(sha1) {
        return entries.first();
    }
    index.by_crc.get(crc).and_then(|e| e.first())
}

/// Compute SHA256 and CRC32 hashes for a file on disk.
pub fn hash_file(path: &Path) -> Result<(String, String)> {
    let data =
        std::fs::read(path).with_context(|| format!("read file: {}", path.display()))?;

    let mut sha = Sha256::new();
    sha.update(&data);
    let sha256 = hex::encode(sha.finalize());

    let crc = crc32fast::hash(&data);
    let crc_str = format!("{:08x}", crc);

    Ok((sha256, crc_str))
}

// ── Internal — fetching and parsing ───────────────────────────────────

/// Fetch a DAT file from GitHub, returning the cached copy if fresh.
async fn fetch_dat(system: &str, cache_dir: &Path) -> Result<String> {
    let filename = format!("{system}.dat");
    let cache_path = cache_dir.join(&filename);

    // Return cached if fresh
    let is_fresh = std::fs::metadata(&cache_path)
        .ok()
        .and_then(|m| m.modified().ok())
        .map(|modified| {
            std::time::SystemTime::now()
                .duration_since(modified)
                .unwrap_or_default()
                .as_secs()
                < DAT_CACHE_TTL_SECS
        })
        .unwrap_or(false);

    if is_fresh {
        return std::fs::read_to_string(&cache_path)
            .with_context(|| format!("read cached DAT: {}", cache_path.display()));
    }

    // Fetch
    let url = format!("{DAT_BASE_URL}/{filename}");
    let client = reqwest::Client::new();
    let resp = client
        .get(&url)
        .send()
        .await
        .with_context(|| format!("fetch DAT: {url}"))?;

    if !resp.status().is_success() {
        anyhow::bail!("DAT fetch {} returned {}", url, resp.status());
    }

    let text = resp
        .text()
        .await
        .with_context(|| format!("read DAT response: {url}"))?;

    // Cache
    if let Some(parent) = cache_path.parent() {
        std::fs::create_dir_all(parent).context("create DAT cache dir")?;
    }
    std::fs::write(&cache_path, &text)
        .with_context(|| format!("cache DAT: {}", cache_path.display()))?;

    Ok(text)
}

/// Parse a Logiqx XML DAT file into entries.
///
/// # Security
/// Validates the `<datafile>` root element. If the response is HTML,
/// JSON, or empty (e.g. a GitHub error page), parsing fails.
fn parse_dat(xml: &str) -> Result<Vec<RomEntry>> {
    use quick_xml::events::Event;
    use quick_xml::Reader;

    let mut reader = Reader::from_str(xml);
    let mut buf = Vec::new();
    let mut entries = Vec::new();

    let mut current_game: Option<String> = None;
    let mut current_rom: Option<RomEntry> = None;
    let mut saw_datafile = false;

    loop {
        match reader.read_event_into(&mut buf)? {
            Event::Start(ref e) => match e.name().as_ref() {
                b"datafile" => saw_datafile = true,
                b"game" => {
                    current_game = e
                        .try_get_attribute("name")?
                        .map(|a| a.unescape_value().unwrap_or_default().to_string());
                }
                b"rom" => {
                    let entry = parse_rom_element(e, current_game.as_deref());
                    current_rom = Some(entry);
                }
                _ => {}
            },
            Event::Empty(ref e) if e.name().as_ref() == b"rom" => {
                // Self-closing <rom .../> — common in DAT files
                let entry = parse_rom_element(e, current_game.as_deref());
                current_rom = Some(entry);
            },
            Event::End(ref e) if e.name().as_ref() == b"game" => {
                if let Some(entry) = current_rom.take() {
                    entries.push(entry);
                }
                current_game = None;
            }
            Event::Eof => break,
            _ => {}
        }
        buf.clear();
    }

    if !saw_datafile {
        anyhow::bail!(
            "DAT file missing <datafile> root element — response may be corrupt or an error page"
        );
    }

    Ok(entries)
}

fn attr(e: &quick_xml::events::BytesStart, name: &str) -> Option<String> {
    e.try_get_attribute(name)
        .ok()
        .flatten()
        .map(|a| a.unescape_value().unwrap_or_default().to_string())
}

/// Parse a `<rom>` element (either open or self-closing) into a [`RomEntry`].
fn parse_rom_element(
    e: &quick_xml::events::BytesStart,
    game_name: Option<&str>,
) -> RomEntry {
    let raw_game = game_name.unwrap_or("");
    RomEntry {
        game_name: raw_game.to_string(),
        canonical_name: canonicalize_name(raw_game),
        rom_name: attr(e, "name").unwrap_or_default(),
        size: attr(e, "size").unwrap_or_default().parse().unwrap_or(0),
        crc: attr(e, "crc").unwrap_or_default(),
        md5: attr(e, "md5").unwrap_or_default(),
        sha1: attr(e, "sha1").unwrap_or_default(),
    }
}

/// Build an in-memory index from parsed entries.
fn index_entries(entries: Vec<RomEntry>) -> DatIndex {
    let mut by_crc: HashMap<String, Vec<RomEntry>> = HashMap::new();
    let mut by_sha1: HashMap<String, Vec<RomEntry>> = HashMap::new();

    for entry in entries {
        by_crc
            .entry(entry.crc.clone())
            .or_default()
            .push(entry.clone());
        by_sha1.entry(entry.sha1.clone()).or_default().push(entry);
    }

    DatIndex { by_crc, by_sha1 }
}

// ── Name canonicalization ──────────────────────────────────────────────

/// Strip region tags, version numbers, and clean up a game name.
fn canonicalize_name(raw: &str) -> String {
    // Remove region/version hints in parentheses: (USA), (V1.2), (Beta), etc.
    let re = regex_lite::Regex::new(
        r"\s*\([^)]*(?:USA|Europe|Japan|NA|UE|J|W|World|Rev\s*\d|V\d[\d.]*|Beta|Proto|Demo|Sample|Pirate|Unl|Hack|En|De|Es|Fr|It|Nl|Pt|Sv|No|Da|Fi|Pl|Ru|Ko|Zh|Ja)[^)]*\)\s*",
    )
    .unwrap();
    let mut name = re.replace_all(raw, " ").to_string();

    // Remove trailing version: " v1.0", " (V2)", "[Rev 3]"
    let re2 = regex_lite::Regex::new(r"\s*[\(\[\{]?\s*(?:v|V|Rev|Version)\s*[\d.]+[\)\]\}]?\s*$")
        .unwrap();
    name = re2.replace_all(&name, "").to_string();

    let trimmed = name.split_whitespace().collect::<Vec<_>>().join(" ");
    trimmed.trim().to_string()
}

// ── Tests ──────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canonicalize_strips_region_and_version() {
        assert_eq!(
            canonicalize_name("Super Mario Land 2 - 6 Golden Coins (UE) (V1.2)"),
            "Super Mario Land 2 - 6 Golden Coins"
        );
        assert_eq!(canonicalize_name("Battlezone (NA)"), "Battlezone");
        assert_eq!(canonicalize_name("Gauntlet II (USA)"), "Gauntlet II");
        assert_eq!(
            canonicalize_name("Action 52 (Unl)"),
            "Action 52"
        );
    }

    #[test]
    fn canonicalize_collapses_whitespace() {
        assert_eq!(
            canonicalize_name("  Double   Space  Game  (USA)  "),
            "Double Space Game"
        );
    }

    #[test]
    fn parse_minimal_dat() {
        let xml = r#"<?xml version="1.0"?>
<datafile>
  <game name="Test Game (USA)">
    <rom name="test.nes" size="65536" crc="ABCD1234" md5="deadbeef" sha1="cafe"/>
  </game>
</datafile>"#;
        let entries = parse_dat(xml).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].game_name, "Test Game (USA)");
        assert_eq!(entries[0].crc, "ABCD1234");
        assert_eq!(entries[0].canonical_name, "Test Game");
    }

    #[test]
    fn parse_rejects_missing_datafile_root() {
        let xml = "<html><body>404 Not Found</body></html>";
        let result = parse_dat(xml);
        assert!(result.is_err());
        assert!(
            result
                .unwrap_err()
                .to_string()
                .contains("datafile")
        );
    }

    #[test]
    fn match_prefers_sha1_over_crc() {
        let entry1 = RomEntry {
            game_name: "Game A".into(),
            canonical_name: "Game A".into(),
            rom_name: "a.nes".into(),
            size: 100,
            crc: "11111111".into(),
            md5: "".into(),
            sha1: "aaaa".into(),
        };
        let entry2 = RomEntry {
            game_name: "Game B".into(),
            canonical_name: "Game B".into(),
            rom_name: "b.nes".into(),
            size: 200,
            crc: "11111111".into(), // same CRC, different SHA1
            md5: "".into(),
            sha1: "bbbb".into(),
        };
        let index = index_entries(vec![entry1, entry2]);

        // SHA1 match returns exact entry
        let found = match_entry(&index, "11111111", "bbbb");
        assert!(found.is_some());
        assert_eq!(found.unwrap().canonical_name, "Game B");

        // CRC match returns first entry with that CRC
        let found = match_entry(&index, "11111111", "cccc");
        assert!(found.is_some());
        assert_eq!(found.unwrap().canonical_name, "Game A");

        // No match
        assert!(match_entry(&index, "00000000", "cccc").is_none());
    }
}
