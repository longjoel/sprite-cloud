//! Libretro info file parser and core discovery.
//!
//! Parses the `.info` files that ship alongside libretro cores (same format
//! RetroArch uses). Every core in `libretro-super` has one.

use std::path::{Path, PathBuf};

use crate::Error;

/// Parsed metadata for a libretro core.
#[derive(Debug, Clone)]
pub struct CoreInfo {
    /// Human-readable display name (e.g. "Nintendo - Game Boy / Color (Gambatte)").
    pub display_name: String,
    /// Short core name (e.g. "Gambatte").
    pub corename: String,
    /// Supported ROM file extensions, split from the pipe-separated list.
    pub supported_extensions: Vec<String>,
    /// Firmware/BIOS files the core may need.
    pub firmware: Vec<FirmwareFile>,
    /// Whether the core requires the real file path (can't load from memory).
    pub needs_fullpath: bool,
    /// Whether save states are supported (deterministic or not).
    pub has_savestate: bool,
    /// Whether the core uses hardware rendering (OpenGL/Vulkan).
    pub hw_render: bool,
}

/// A firmware file needed (or optionally needed) by a core.
#[derive(Debug, Clone)]
pub struct FirmwareFile {
    /// Relative path within the system directory (e.g. "gb_bios.bin").
    pub path: String,
    /// Human-readable description (e.g. "Game Boy BIOS").
    pub description: String,
    /// If true, the core works without this file.
    pub optional: bool,
}

/// Parse a single `.info` file's content into a [`CoreInfo`].
///
/// Format is simple key-value:
/// ```text
/// display_name = "Nintendo - Game Boy / Color (Gambatte)"
/// supported_extensions = "gb|gbc|dmg"
/// firmware_count = 2
/// firmware0_desc = "gb_bios.bin (Game Boy BIOS)"
/// firmware0_path = "gb_bios.bin"
/// firmware0_opt = "true"
/// ```
pub fn parse_info(content: &str) -> Result<CoreInfo, Error> {
    let mut values: Vec<(&str, String)> = Vec::new();

    for line in content.lines() {
        let line = line.trim();

        // Skip comments and empty lines
        if line.is_empty() || line.starts_with('#') {
            continue;
        }

        // Split on first '='
        let Some(eq_pos) = line.find('=') else {
            continue; // skip malformed lines
        };

        let key = line[..eq_pos].trim();
        let raw_value = line[eq_pos + 1..].trim();

        // Strip surrounding quotes if present
        let value = if raw_value.starts_with('"') && raw_value.ends_with('"') {
            raw_value[1..raw_value.len() - 1].to_string()
        } else {
            raw_value.to_string()
        };

        values.push((key, value));
    }

    let get = |key: &str| -> Result<String, Error> {
        values
            .iter()
            .find(|(k, _)| *k == key)
            .map(|(_, v)| v.clone())
            .ok_or_else(|| Error::Other(format!("missing required field: {key}")))
    };

    let get_bool = |key: &str| -> bool {
        values
            .iter()
            .find(|(k, _)| *k == key)
            .map(|(_, v)| v == "true")
            .unwrap_or(false)
    };

    let display_name = get("display_name")?;
    let corename = get("corename")?;
    let extensions_str = get("supported_extensions")?;
    let supported_extensions: Vec<String> = extensions_str
        .split('|')
        .map(|s| s.trim().to_lowercase())
        .filter(|s| !s.is_empty())
        .collect();

    let firmware_count: usize = values
        .iter()
        .find(|(k, _)| *k == "firmware_count")
        .and_then(|(_, v)| v.parse().ok())
        .unwrap_or(0);

    let mut firmware = Vec::with_capacity(firmware_count);
    for i in 0..firmware_count {
        let desc = get(&format!("firmware{i}_desc")).unwrap_or_default();
        let path = get(&format!("firmware{i}_path")).unwrap_or_default();
        let opt = values
            .iter()
            .find(|(k, _)| *k == format!("firmware{i}_opt"))
            .map(|(_, v)| v == "true")
            .unwrap_or(true);

        if !path.is_empty() {
            firmware.push(FirmwareFile {
                path,
                description: desc,
                optional: opt,
            });
        }
    }

    Ok(CoreInfo {
        display_name,
        corename,
        supported_extensions,
        firmware,
        needs_fullpath: get_bool("needs_fullpath"),
        has_savestate: get_bool("savestate"),
        hw_render: get_bool("hw_render"),
    })
}

/// Discover all cores in a directory by scanning for `*_libretro.info` files.
///
/// Returns a list of `(CoreInfo, path_to_so)` pairs. Each info file's
/// basename determines the expected `.so` name: `gambatte_libretro.info`
/// expects `gambatte_libretro.so`.
pub fn discover_cores(core_dir: &Path) -> Result<Vec<(CoreInfo, PathBuf)>, Error> {
    let mut catalog = Vec::new();

    let entries = std::fs::read_dir(core_dir).map_err(|e| {
        Error::Other(format!(
            "failed to read core directory {}: {e}",
            core_dir.display()
        ))
    })?;

    for entry in entries {
        let entry =
            entry.map_err(|e| Error::Other(format!("failed to read directory entry: {e}")))?;
        let path = entry.path();

        // Only look at .info files
        if path.extension().and_then(|s| s.to_str()) != Some("info") {
            continue;
        }

        // Read and parse
        let content = std::fs::read_to_string(&path)
            .map_err(|e| Error::Other(format!("failed to read {}: {e}", path.display())))?;

        let info = parse_info(&content)
            .map_err(|e| Error::Other(format!("failed to parse {}: {e}", path.display())))?;

        // Find matching .so — strip _libretro.info and look for _libretro.so
        let file_stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("");
        let so_name = format!("{file_stem}.so");
        let so_path = core_dir.join(&so_name);

        if so_path.exists() {
            catalog.push((info, so_path));
        }
    }

    Ok(catalog)
}

/// Find the first core in the catalog that supports a ROM file's extension.
pub fn detect_core<'a>(
    catalog: &'a [(CoreInfo, PathBuf)],
    rom_path: &Path,
) -> Option<&'a (CoreInfo, PathBuf)> {
    let ext = rom_path.extension()?.to_str()?.to_lowercase();
    catalog
        .iter()
        .find(|(info, _)| info.supported_extensions.contains(&ext))
}

/// Check which firmware files for a core exist on disk.
///
/// Returns a list of `(name, description)` for missing required firmware.
/// Optional firmware is not reported as missing.
pub fn check_firmware(info: &CoreInfo, system_dir: &Path) -> Vec<(String, String)> {
    info.firmware
        .iter()
        .filter(|fw| !fw.optional && !system_dir.join(&fw.path).exists())
        .map(|fw| (fw.path.clone(), fw.description.clone()))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    const GAMBATTE_INFO: &str = r#"# Software Information
display_name = "Nintendo - Game Boy / Color (Gambatte)"
authors = "Sinamas"
supported_extensions = "gb|gbc|dmg"
corename = "Gambatte"
license = "GPLv2"
display_version = "v0.5.0"
categories = "Emulator"

# Hardware Information
manufacturer = "Nintendo"
systemname = "Game Boy/Game Boy Color"

# Libretro Features
supports_no_game = "false"
savestate = "true"
savestate_features = "deterministic"
hw_render = "false"
needs_fullpath = "false"

# BIOS / Firmware
firmware_count = 2
firmware0_desc = "gb_bios.bin (Game Boy BIOS)"
firmware0_path = "gb_bios.bin"
firmware0_opt = "true"
firmware1_desc = "gbc_bios.bin (Game Boy Color BIOS)"
firmware1_path = "gbc_bios.bin"
firmware1_opt = "true"
notes = "(!) gb_bios.bin (md5): 32fbbd84168d3482956eb3c5051637f5"
"#;

    #[test]
    fn parse_gambatte_info() {
        let info = parse_info(GAMBATTE_INFO).expect("should parse successfully");

        assert_eq!(info.display_name, "Nintendo - Game Boy / Color (Gambatte)");
        assert_eq!(info.corename, "Gambatte");
        assert_eq!(
            info.supported_extensions,
            vec!["gb".to_string(), "gbc".to_string(), "dmg".to_string()]
        );
        assert!(info.has_savestate);
        assert!(!info.hw_render);
        assert!(!info.needs_fullpath);

        assert_eq!(info.firmware.len(), 2);
        assert_eq!(info.firmware[0].path, "gb_bios.bin");
        assert_eq!(info.firmware[0].description, "gb_bios.bin (Game Boy BIOS)");
        assert!(info.firmware[0].optional);
        assert_eq!(info.firmware[1].path, "gbc_bios.bin");
        assert!(info.firmware[1].optional);
    }

    #[test]
    fn parse_info_missing_required_field() {
        let result = parse_info("corename = \"Test\"\n");
        assert!(result.is_err());
    }

    #[test]
    fn parse_info_empty_firmware() {
        let info = parse_info(
            "display_name = \"Test\"\ncorename = \"Test\"\nsupported_extensions = \"bin\"\nfirmware_count = 0\n",
        )
        .expect("should parse");
        assert!(info.firmware.is_empty());
    }

    #[test]
    fn detect_core_by_extension() {
        let info = CoreInfo {
            display_name: "Gambatte".into(),
            corename: "Gambatte".into(),
            supported_extensions: vec!["gb".into(), "gbc".into()],
            firmware: vec![],
            needs_fullpath: false,
            has_savestate: true,
            hw_render: false,
        };
        let catalog = vec![(info, PathBuf::from("/cores/gambatte.so"))];

        let found = detect_core(&catalog, Path::new("/roms/zelda.gbc"));
        assert!(found.is_some());
        assert_eq!(found.unwrap().0.corename, "Gambatte");

        let not_found = detect_core(&catalog, Path::new("/roms/smw.sfc"));
        assert!(not_found.is_none());
    }

    #[test]
    fn check_firmware_reports_missing() {
        let info = CoreInfo {
            display_name: "FBNeo".into(),
            corename: "FBNeo".into(),
            supported_extensions: vec!["zip".into()],
            firmware: vec![
                FirmwareFile {
                    path: "neogeo.zip".into(),
                    description: "Neo Geo BIOS".into(),
                    optional: false,
                },
                FirmwareFile {
                    path: "optional.bin".into(),
                    description: "Optional BIOS".into(),
                    optional: true,
                },
            ],
            needs_fullpath: false,
            has_savestate: true,
            hw_render: false,
        };

        let missing = check_firmware(&info, Path::new("/nonexistent"));
        assert_eq!(missing.len(), 1); // only required, not optional
        assert_eq!(missing[0].0, "neogeo.zip");
    }
}
