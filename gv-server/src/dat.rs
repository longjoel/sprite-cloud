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
//! - System names come from `platform::dat_system_name()`, never user input.
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

// ── Public types ───────────────────────────────────────────────────────

/// One ROM entry from a DAT file.
#[derive(Debug, Clone)]
pub struct RomEntry {
    pub game_name: String,
    /// Parsed from DAT but only used in tests / canonical naming.
    /// Kept for completeness of the DAT format model.
    #[allow(dead_code)]
    pub rom_name: String,
    #[allow(dead_code)]
    pub size: u64,
    pub crc: String,
    #[allow(dead_code)]
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

impl DatIndex {
    /// Merge another index's entries into this one.
    pub fn merge(&mut self, other: DatIndex) {
        for (k, v) in other.by_crc {
            self.by_crc.entry(k).or_default().extend(v);
        }
        for (k, v) in other.by_sha1 {
            self.by_sha1.entry(k).or_default().extend(v);
        }
    }
}

// ── Public API ─────────────────────────────────────────────────────────

/// Build a [`DatIndex`] for the platform that matches a file extension.
///
/// Fetches and caches the DAT file from GitHub if needed, then indexes
/// all entries. Returns `None` if no DAT file exists for the extension.
pub async fn load_for_extension(ext: &str, cache_dir: &Path) -> Option<DatIndex> {
    let ext = ext.to_lowercase();
    let system = crate::platform::dat_system_name(&ext)?;

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
    let data = std::fs::read(path).with_context(|| format!("read file: {}", path.display()))?;

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

/// Parse a DAT file into entries. Supports two formats:
///
/// 1. **clrmamepro** — parenthesized format used by libretro-database:
///    ```text
///    game (
///        name "Game Name"
///        rom ( name "file.nes" size N crc XXXXXXXX md5 ... sha1 ... )
///    )
///    ```
/// 2. **Logiqx XML** — traditional `<datafile><game><rom/></game></datafile>`.
///
/// # Security
/// If neither format is detected, parsing fails — corrupt/HTML/JSON
/// responses produce an error, not bad matches.
fn parse_dat(input: &str) -> Result<Vec<RomEntry>> {
    // Detect format: clrmamepro starts with "clrmamepro"; XML with "<"
    let trimmed = input.trim_start();
    if trimmed.starts_with("clrmamepro") {
        return parse_dat_clrmamepro(input);
    }
    if trimmed.starts_with('<') {
        return parse_dat_xml(input);
    }
    anyhow::bail!("unknown DAT format — expected clrmamepro or XML");
}

/// Parse clrmamepro-format DAT (parenthesized, used by libretro-database).
fn parse_dat_clrmamepro(input: &str) -> Result<Vec<RomEntry>> {
    let mut entries = Vec::new();

    // Find each "game (...)" block.  Inside each game block, find the
    // "rom (...)" sub-block and extract key-value pairs.
    let mut pos = 0;
    let bytes = input.as_bytes();
    let len = bytes.len();

    while pos < len {
        // Find next "game (" token
        if let Some(game_start) = input[pos..].find("game (") {
            let gs = pos + game_start + 6; // skip "game ("
            // Find the matching closing paren for the game block
            let game_close = find_matching_paren(bytes, gs - 1)?;
            let game_block = &input[gs..game_close];

            // Extract game name from the game block
            let game_name = extract_clrmamepro_value(game_block, "name");

            // Find "rom (" inside the game block
            if let Some(rom_start) = game_block.find("rom (") {
                let rs = rom_start + 5; // skip "rom ("
                let rom_block_bytes = game_block.as_bytes();
                let rom_close = find_matching_paren(rom_block_bytes, rs - 1)?;
                let rom_block = &game_block[rs..rom_close];

                let entry = RomEntry {
                    game_name: game_name.clone().unwrap_or_default(),
                    canonical_name: canonicalize_name(&game_name.unwrap_or_default()),
                    rom_name: extract_clrmamepro_value(rom_block, "name").unwrap_or_default(),
                    size: extract_clrmamepro_value(rom_block, "size")
                        .unwrap_or_default()
                        .parse()
                        .unwrap_or(0),
                    crc: extract_clrmamepro_value(rom_block, "crc")
                        .unwrap_or_default()
                        .to_lowercase(),
                    md5: extract_clrmamepro_value(rom_block, "md5")
                        .unwrap_or_default()
                        .to_lowercase(),
                    sha1: extract_clrmamepro_value(rom_block, "sha1")
                        .unwrap_or_default()
                        .to_lowercase(),
                };

                // Only include entries with a valid CRC (required for matching)
                if !entry.crc.is_empty() {
                    entries.push(entry);
                }
            }

            pos = game_close + 1;
        } else {
            break;
        }
    }

    if entries.is_empty() {
        anyhow::bail!("no game entries found in DAT");
    }

    Ok(entries)
}

/// Parse Logiqx XML-format DAT (traditional).
fn parse_dat_xml(xml: &str) -> Result<Vec<RomEntry>> {
    use quick_xml::Reader;
    use quick_xml::events::Event;

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
                let entry = parse_rom_element(e, current_game.as_deref());
                current_rom = Some(entry);
            }
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

/// Find the index of the closing paren matching the open paren at
/// `open_pos` in `bytes`.  Handles nested parens and quoted strings.
fn find_matching_paren(bytes: &[u8], open_pos: usize) -> Result<usize> {
    let mut depth = 0;
    let mut in_quotes = false;

    for (i, &b) in bytes.iter().enumerate().skip(open_pos + 1) {
        if b == b'"' {
            in_quotes = !in_quotes;
            continue;
        }
        if in_quotes {
            continue;
        }
        if b == b'(' {
            depth += 1;
        } else if b == b')' {
            if depth == 0 {
                return Ok(i);
            }
            depth -= 1;
        }
    }

    anyhow::bail!("unmatched parenthesis in DAT file")
}

/// Extract a space-separated key-value from clrmamepro format.
/// Values are quoted strings (`name "Game Name"`) or bare tokens
/// (`size 262160`). Returns `None` if the key is not found.
fn extract_clrmamepro_value(block: &str, key: &str) -> Option<String> {
    let search = format!(" {} ", key);
    if let Some(pos) = block.find(&search) {
        let rest = &block[pos + search.len()..];
        let rest = rest.trim_start();
        if let Some(stripped) = rest.strip_prefix('"') {
            // Quoted value
            let end = stripped.find('"')?;
            Some(stripped[..end].to_string())
        } else {
            // Bare token (e.g., size 262160)
            let end = rest
                .find(|c: char| c.is_whitespace() || c == ')')
                .unwrap_or(rest.len());
            Some(rest[..end].to_string())
        }
    } else {
        None
    }
}

fn attr(e: &quick_xml::events::BytesStart, name: &str) -> Option<String> {
    e.try_get_attribute(name)
        .ok()
        .flatten()
        .map(|a| a.unescape_value().unwrap_or_default().to_string())
}

/// Parse a `<rom>` element (either open or self-closing) into a [`RomEntry`].
fn parse_rom_element(e: &quick_xml::events::BytesStart, game_name: Option<&str>) -> RomEntry {
    let raw_game = game_name.unwrap_or("");
    RomEntry {
        game_name: raw_game.to_string(),
        canonical_name: canonicalize_name(raw_game),
        rom_name: attr(e, "name").unwrap_or_default(),
        size: attr(e, "size").unwrap_or_default().parse().unwrap_or(0),
        crc: attr(e, "crc").unwrap_or_default().to_lowercase(),
        md5: attr(e, "md5").unwrap_or_default().to_lowercase(),
        sha1: attr(e, "sha1").unwrap_or_default().to_lowercase(),
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
        assert_eq!(canonicalize_name("Action 52 (Unl)"), "Action 52");
    }

    #[test]
    fn canonicalize_collapses_whitespace() {
        assert_eq!(
            canonicalize_name("  Double   Space  Game  (USA)  "),
            "Double Space Game"
        );
    }

    #[test]
    fn parse_minimal_xml_dat() {
        let xml = r#"<?xml version="1.0"?>
<datafile>
  <game name="Test Game (USA)">
    <rom name="test.nes" size="65536" crc="ABCD1234" md5="deadbeef" sha1="cafe"/>
  </game>
</datafile>"#;
        let entries = parse_dat(xml).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].game_name, "Test Game (USA)");
        assert_eq!(entries[0].crc, "abcd1234"); // normalized to lowercase
        assert_eq!(entries[0].canonical_name, "Test Game");
    }

    #[test]
    fn parse_minimal_clrmamepro_dat() {
        let dat = r#"clrmamepro (
    name "Nintendo - Nintendo Entertainment System"
)
game (
    name "Super Mario Bros. (World)"
    rom ( name "Super Mario Bros. (World).nes" size 40976 crc 3337ec46 md5 deadbeef sha1 cafe )
)"#;
        let entries = parse_dat(dat).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].game_name, "Super Mario Bros. (World)");
        assert_eq!(entries[0].rom_name, "Super Mario Bros. (World).nes");
        assert_eq!(entries[0].size, 40976);
        assert_eq!(entries[0].crc, "3337ec46");
        assert_eq!(entries[0].canonical_name, "Super Mario Bros.");
    }

    #[test]
    fn parse_rejects_html() {
        let xml = "<html><body>404 Not Found</body></html>";
        let result = parse_dat(xml);
        assert!(result.is_err());
        let msg = result.unwrap_err().to_string();
        assert!(msg.contains("datafile") || msg.contains("unknown DAT format"));
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
