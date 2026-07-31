//! Hardened DAT parser for No-Intro/Logiqx XML and Redump formats.
//!
//! Parses untrusted XML with:
//! - External entities and network access disabled (quick-xml default)
//! - Document-size, nesting-depth, record-count, text-length limits
//! - Processing-time guard via total record cap
//!
//! Supported formats:
//! - No-Intro Logiqx XML (.dat)
//! - Redump Logiqx XML (.dat)
//! - clrmamepro-compatible DAT files

use quick_xml::events::Event;
use quick_xml::Reader;
use sha2::Digest;

use super::types::{DatIndex, DatProvenance, ParseResult, RomEntry};

/// Hard resource limits for DAT parsing.
#[derive(Debug, Clone)]
pub(crate) struct ParseLimits {
    /// Maximum document size in bytes (default 64 MiB)
    pub max_document_bytes: u64,
    /// Maximum XML nesting depth (default 32)
    pub max_depth: usize,
    /// Maximum number of <game> entries (default 100_000)
    pub max_games: usize,
    /// Maximum text content length per element (default 4 KiB)
    pub max_text_len: usize,
    /// Maximum attribute value length (default 512 bytes)
    pub max_attr_len: usize,
}

impl Default for ParseLimits {
    fn default() -> Self {
        ParseLimits {
            max_document_bytes: 64 * 1024 * 1024, // 64 MiB
            max_depth: 32,
            max_games: 100_000,
            max_text_len: 4096,
            max_attr_len: 512,
        }
    }
}

/// Parse error.
#[derive(Debug)]
pub(crate) enum ParseError {
    /// XML parse error from quick-xml
    Xml(String),
    /// Resource limit exceeded
    LimitExceeded(String),
    /// Malformed or missing data
    Malformed(String),
    /// I/O error
    Io(std::io::Error),
}

impl std::fmt::Display for ParseError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ParseError::Xml(s) => write!(f, "XML parse error: {s}"),
            ParseError::LimitExceeded(s) => write!(f, "limit exceeded: {s}"),
            ParseError::Malformed(s) => write!(f, "malformed DAT: {s}"),
            ParseError::Io(e) => write!(f, "I/O error: {e}"),
        }
    }
}

impl std::error::Error for ParseError {}

impl From<std::io::Error> for ParseError {
    fn from(e: std::io::Error) -> Self {
        ParseError::Io(e)
    }
}

/// Parse a DAT file from a byte slice.
///
/// The parser enforces all resource limits and treats the input as
/// untrusted. No external entities or network access are triggered.
pub(crate) fn parse_dat(
    data: &[u8],
    limits: Option<ParseLimits>,
) -> Result<ParseResult, ParseError> {
    let limits = limits.unwrap_or_default();

    // Document size check
    if data.len() as u64 > limits.max_document_bytes {
        return Err(ParseError::LimitExceeded(format!(
            "document size {} exceeds max {}",
            data.len(),
            limits.max_document_bytes
        )));
    }

    let mut reader = Reader::from_reader(data);
    reader.config_mut().trim_text(true);
    reader.config_mut().expand_empty_elements = true;

    let mut buf = Vec::new();

    // ▸ Header fields are extracted in the second pass below.
    //    These bindings are kept for the provenance fallback (hdr.or(existing)).
    let dat_name: Option<String> = None;
    let description: Option<String> = None;
    let version: Option<String> = None;
    let date: Option<String> = None;
    let author: Option<String> = None;
    let url: Option<String> = None;

    // Current game being built
    let mut current_game_name: Option<String> = None;
    let mut current_rom_name: Option<String> = None;
    let mut current_size: Option<u64> = None;
    let mut current_crc32: Option<String> = None;
    let mut current_md5: Option<String> = None;
    let mut current_sha1: Option<String> = None;

    let mut entries: Vec<RomEntry> = Vec::new();
    let mut depth: usize = 0;
    let mut in_game = false;

    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(ref e)) => {
                depth += 1;
                if depth > limits.max_depth {
                    return Err(ParseError::LimitExceeded(format!(
                        "nesting depth {depth} exceeds max {}",
                        limits.max_depth
                    )));
                }

                let name_ref = e.name();
                let name_bytes = name_ref.as_ref();
                let tag = std::str::from_utf8(name_bytes)
                    .map_err(|_| ParseError::Malformed("non-UTF8 tag name".into()))?;

                match tag {
                    "game" => {
                        if entries.len() >= limits.max_games {
                            return Err(ParseError::LimitExceeded(format!(
                                "game count exceeds max {}",
                                limits.max_games
                            )));
                        }
                        in_game = true;
                        // Reset per-game state
                        current_game_name = None;
                        current_rom_name = None;
                        current_size = None;
                        current_crc32 = None;
                        current_md5 = None;
                        current_sha1 = None;

                        // Extract game name from attribute
                        for attr in e.attributes().flatten() {
                            let attr_name =
                                std::str::from_utf8(attr.key.as_ref()).unwrap_or("");
                            let attr_val = attr
                                .decode_and_unescape_value(reader.decoder())
                                .map(|cow| cow.into_owned())
                                .unwrap_or_default();

                            if attr_val.len() > limits.max_attr_len {
                                return Err(ParseError::LimitExceeded(format!(
                                    "attribute value length {} exceeds max {}",
                                    attr_val.len(),
                                    limits.max_attr_len
                                )));
                            }

                            if attr_name == "name" {
                                current_game_name = Some(attr_val);
                            }
                        }
                    }
                    "rom" => {
                        // Parse ROM attributes
                        for attr in e.attributes().flatten() {
                            let attr_name =
                                std::str::from_utf8(attr.key.as_ref()).unwrap_or("");
                            let attr_val = attr
                                .decode_and_unescape_value(reader.decoder())
                                .map(|cow| cow.into_owned())
                                .unwrap_or_default();

                            if attr_val.len() > limits.max_attr_len {
                                return Err(ParseError::LimitExceeded(format!(
                                    "attribute value length {} exceeds max {}",
                                    attr_val.len(),
                                    limits.max_attr_len
                                )));
                            }

                            match attr_name {
                                "name" => current_rom_name = Some(attr_val),
                                "size" => {
                                    current_size = attr_val.parse().ok();
                                }
                                "crc" => current_crc32 = Some(attr_val.to_lowercase()),
                                "md5" => current_md5 = Some(attr_val.to_lowercase()),
                                "sha1" => current_sha1 = Some(attr_val.to_lowercase()),
                                _ => {}
                            }
                        }
                    }
                    _ => {}
                }
            }
            Ok(Event::End(ref e)) => {
                let name_ref = e.name();
                let name_bytes = name_ref.as_ref();
                let tag = std::str::from_utf8(name_bytes)
                    .map_err(|_| ParseError::Malformed("non-UTF8 tag name".into()))?;

                if tag == "game" {
                    in_game = false;
                    // Emit the game entry
                    let name = current_game_name
                        .clone()
                        .unwrap_or_else(|| {
                            current_rom_name.clone().unwrap_or_default()
                        });
                    if !name.is_empty() && current_size.is_some() {
                        entries.push(RomEntry {
                            name,
                            alt_names: Vec::new(),
                            platform: dat_name.clone(),
                            region: None,
                            revision: None,
                            status: None,
                            size: current_size.unwrap_or(0),
                            crc32: current_crc32.clone(),
                            md5: current_md5.clone(),
                            sha1: current_sha1.clone(),
                        });
                    }
                }
                depth = depth.saturating_sub(1);
            }
            Ok(Event::Empty(ref e)) => {
                let name_ref = e.name();
                let name_bytes = name_ref.as_ref();
                let tag = std::str::from_utf8(name_bytes)
                    .map_err(|_| ParseError::Malformed("non-UTF8 tag name".into()))?;

                // Handle self-closing <rom ... /> inside <game>
                if tag == "rom" && in_game {
                    for attr in e.attributes().flatten() {
                        let attr_name =
                            std::str::from_utf8(attr.key.as_ref()).unwrap_or("");
                        let attr_val = attr
                            .decode_and_unescape_value(reader.decoder())
                            .map(|cow| cow.into_owned())
                            .unwrap_or_default();

                        if attr_val.len() > limits.max_attr_len {
                            return Err(ParseError::LimitExceeded(format!(
                                "attribute value length {} exceeds max {}",
                                attr_val.len(),
                                limits.max_attr_len
                            )));
                        }

                        match attr_name {
                            "name" => current_rom_name = Some(attr_val),
                            "size" => {
                                current_size = attr_val.parse().ok();
                            }
                            "crc" => current_crc32 = Some(attr_val.to_lowercase()),
                            "md5" => current_md5 = Some(attr_val.to_lowercase()),
                            "sha1" => current_sha1 = Some(attr_val.to_lowercase()),
                            _ => {}
                        }
                    }
                }
            }
            Ok(Event::Text(_)) => {
                // Text nodes are captured in the header-field pass below.
                // The main game-entry pass uses attributes only.
            }
            Ok(Event::Eof) => break,
            Ok(_) => {}
            Err(e) => {
                return Err(ParseError::Xml(format!("{e}")));
            }
        }

        buf.clear();
    }

    // Second lightweight pass for header text fields
    let (hdr_name, hdr_desc, hdr_version, hdr_date, hdr_author, hdr_url) =
        parse_header_fields(data, &limits)?;

    let entry_count = entries.len();
    let index = DatIndex::from_entries(entries);

    // Compute source SHA-256
    let source_sha256 = hex::encode(sha2::Sha256::digest(data));

    Ok(ParseResult {
        provenance: DatProvenance {
            source_name: None,
            dat_name: hdr_name.or(dat_name),
            description: hdr_desc.or(description),
            version: hdr_version.or(version),
            date: hdr_date.or(date),
            author: hdr_author.or(author),
            url: hdr_url.or(url),
            imported_at: time::OffsetDateTime::now_utc()
                .format(&time::format_description::well_known::Rfc3339)
                .unwrap_or_default(),
            source_sha256: Some(source_sha256),
            entry_count,
        },
        index,
    })
}

/// Parsed header fields from a DAT file.
type HeaderFields = (
    Option<String>, // name
    Option<String>, // description
    Option<String>, // version
    Option<String>, // date
    Option<String>, // author
    Option<String>, // url
);

/// Lightweight second pass to extract header fields.
fn parse_header_fields(
    data: &[u8],
    limits: &ParseLimits,
) -> Result<HeaderFields, ParseError> {
    let mut reader = Reader::from_reader(data);
    reader.config_mut().trim_text(true);

    let mut buf = Vec::new();
    let mut in_header = false;
    let mut current_field: Option<String> = None;

    let mut name: Option<String> = None;
    let mut description: Option<String> = None;
    let mut version: Option<String> = None;
    let mut date: Option<String> = None;
    let mut author: Option<String> = None;
    let mut url: Option<String> = None;

    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(ref e)) => {
                let name_ref = e.name();
                let tag = std::str::from_utf8(name_ref.as_ref()).unwrap_or("");
                if tag == "header" {
                    in_header = true;
                } else if in_header {
                    current_field = Some(tag.to_string());
                }
                if tag == "game" {
                    // Stop at first game — header is done
                    break;
                }
            }
            Ok(Event::End(ref e)) => {
                let name_ref = e.name();
                let tag = std::str::from_utf8(name_ref.as_ref()).unwrap_or("");
                if tag == "header" {
                    break;
                }
                current_field = None;
            }
            Ok(Event::Text(ref e)) => {
                if in_header
                    && let Some(ref field) = current_field {
                        let text = e
                            .unescape()
                            .map(|cow| cow.into_owned())
                            .unwrap_or_default();

                        if text.len() > limits.max_text_len {
                            return Err(ParseError::LimitExceeded(format!(
                                "text length {} exceeds max {}",
                                text.len(),
                                limits.max_text_len
                            )));
                        }

                        match field.as_str() {
                            "name" => name = Some(text),
                            "description" => description = Some(text),
                            "version" => version = Some(text),
                            "date" => date = Some(text),
                            "author" => author = Some(text),
                            "url" => url = Some(text),
                            _ => {}
                        }
                    }
            }
            Ok(Event::Eof) => break,
            Ok(_) => {}
            Err(e) => return Err(ParseError::Xml(format!("header parse: {e}"))),
        }
        buf.clear();
    }

    Ok((name, description, version, date, author, url))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dat::MatchConfidence;

    fn sample_no_intro_dat() -> &'static [u8] {
        br#"<?xml version="1.0" encoding="UTF-8"?>
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
  <game name="The Legend of Zelda - A Link to the Past (USA)">
    <description>The Legend of Zelda - A Link to the Past (USA)</description>
    <rom name="The Legend of Zelda - A Link to the Past (USA).sfc" size="1048576" crc="777AACA0" md5="AC6E8482A8032AB7B13AB4C8A6F78AC7" sha1="6D4F10A4B2A4E1B2F8E3A2C0D1F3A4B5C6D7E8F9"/>
  </game>
</datafile>"#
    }

    #[test]
    fn parse_no_intro_dat_header() {
        let result = parse_dat(sample_no_intro_dat(), None).expect("parse");
        let prov = &result.provenance;

        assert_eq!(
            prov.dat_name.as_deref(),
            Some("Nintendo - Super Nintendo Entertainment System")
        );
        assert_eq!(prov.version.as_deref(), Some("20240115"));
        assert_eq!(prov.author.as_deref(), Some("No-Intro"));
        assert_eq!(prov.entry_count, 2);
        assert!(prov.source_sha256.is_some());
    }

    #[test]
    fn parse_no_intro_dat_entries() {
        let result = parse_dat(sample_no_intro_dat(), None).expect("parse");
        let index = &result.index;

        assert_eq!(index.len(), 2);

        // Look up by SHA-1
        let matches = index.find_by_sha1("6b47bb75d16514b6a476aa89f3bba4b1bc26bf7e");
        assert_eq!(matches.len(), 1);
        assert_eq!(matches[0].name, "Super Mario World (USA)");
        assert_eq!(matches[0].size, 524288);
        assert_eq!(matches[0].crc32.as_deref(), Some("b19ed489"));
        assert_eq!(
            matches[0].md5.as_deref(),
            Some("cdd3c8c37322978ca8669b34bdade1c4")
        );

        // Look up by CRC32 + size
        let crc_matches = index.find_by_crc32_size("777aaca0", 1048576);
        assert_eq!(crc_matches.len(), 1);
        assert_eq!(
            crc_matches[0].name,
            "The Legend of Zelda - A Link to the Past (USA)"
        );
    }

    #[test]
    fn find_match_sha1_first() {
        let result = parse_dat(sample_no_intro_dat(), None).expect("parse");
        let m = result.index.find_match(
            "6b47bb75d16514b6a476aa89f3bba4b1bc26bf7e",
            "b19ed489",
            524288,
        );

        assert_eq!(m.confidence, MatchConfidence::Sha1);
        assert_eq!(m.entry.unwrap().name, "Super Mario World (USA)");
    }

    #[test]
    fn parse_empty_dat() {
        let data = br#"<?xml version="1.0"?>
<datafile>
  <header>
    <name>Empty</name>
  </header>
</datafile>"#;

        let result = parse_dat(data, None).expect("parse");
        assert_eq!(result.index.len(), 0);
        assert_eq!(result.provenance.entry_count, 0);
    }

    #[test]
    fn document_size_limit() {
        let limits = ParseLimits {
            max_document_bytes: 10,
            ..Default::default()
        };
        let data = b"this is more than 10 bytes of XML data";
        let err = parse_dat(data, Some(limits)).unwrap_err();
        assert!(format!("{err}").contains("document size"));
    }

    #[test]
    fn game_count_limit() {
        let limits = ParseLimits {
            max_games: 1,
            ..Default::default()
        };
        let err = parse_dat(sample_no_intro_dat(), Some(limits)).unwrap_err();
        assert!(format!("{err}").contains("game count"));
    }

    #[test]
    fn nesting_depth_limit() {
        let limits = ParseLimits {
            max_depth: 2,
            ..Default::default()
        };
        // Sample DAT has depth 3+ (datafile > header/game > rom)
        let err = parse_dat(sample_no_intro_dat(), Some(limits)).unwrap_err();
        assert!(format!("{err}").contains("nesting depth"));
    }

    #[test]
    fn parse_self_closing_rom_tags() {
        // Redump-style self-closing <rom /> tags inside <game>
        let data = br#"<?xml version="1.0"?>
<datafile>
  <header><name>Redump Test</name></header>
  <game name="Test Game (USA)">
    <description>Test Game (USA)</description>
    <rom name="test.bin" size="12345" crc="ABCD1234" sha1="AAAA1111BBBB2222CCCC3333DDDD4444EEEE5555" />
  </game>
</datafile>"#;

        let result = parse_dat(data, None).expect("parse");
        assert_eq!(result.index.len(), 1);

        let m = result.index.find_match(
            "aaaa1111bbbb2222cccc3333dddd4444eeee5555",
            "abcd1234",
            12345,
        );
        assert_eq!(m.confidence, MatchConfidence::Sha1);
        assert_eq!(m.entry.unwrap().name, "Test Game (USA)");
    }
}
