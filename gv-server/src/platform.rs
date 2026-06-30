//! Single canonical platform manifest — the one source of truth for
//! platform identity, ROM extension detection, DAT resolution, and
//! libretro core assignment.
//!
//! Consolidates the three former lookup tables:
//! * `scan::EXTENSION_MAP`       (extension → short name)
//! * `worker::CORE_MAP`          (platform name → core filename)
//! * `dat::DAT_SYSTEM_NAMES`     (extension → full DAT name)

// ── Manifest definition ─────────────────────────────────────────────────

/// One platform entry.
///
/// `short_name` is the canonical display name used in the UI and
/// scanner output.  `aliases` include full RetroArch DAT names and
/// any other known identifiers.  `extensions` are lowercase ROM
/// file extensions.  `core` is the libretro core `.so` filename.
#[derive(Debug, Clone)]
pub struct PlatformManifest {
    pub short_name: &'static str,
    pub aliases: &'static [&'static str],
    pub extensions: &'static [&'static str],
    pub core: &'static str,
    /// Audio channel count for this platform (1 = mono, 2 = stereo).
    pub audio_channels: u16,
}

/// Every platform known to Sprite Cloud.
///
/// Order: more-specific entries before broader ones to preserve
/// first-match-wins semantics (e.g. "Game Boy Advance" before
/// "Game Boy").
pub const PLATFORMS: &[PlatformManifest] = &[
    // ── Nintendo — Game Boy family ─────────────────────────────────
    PlatformManifest {
        short_name: "Game Boy Advance",
        aliases: &["Nintendo - Game Boy Advance"],
        extensions: &["gba"],
        core: "mgba_libretro.so",
        audio_channels: 1,
    },
    PlatformManifest {
        short_name: "Game Boy Color",
        aliases: &["Nintendo - Game Boy Color"],
        extensions: &["gbc"],
        core: "sameboy_libretro.so",
        audio_channels: 1,
    },
    PlatformManifest {
        short_name: "Game Boy",
        aliases: &["Nintendo - Game Boy"],
        extensions: &["gb"],
        core: "sameboy_libretro.so",
        audio_channels: 1,
    },
    // ── Nintendo — NES ────────────────────────────────────────────
    PlatformManifest {
        short_name: "NES",
        aliases: &["Nintendo - Nintendo Entertainment System"],
        extensions: &["nes"],
        core: "nestopia_libretro.so",
        audio_channels: 1,
    },
    PlatformManifest {
        short_name: "Family Computer Disk System",
        aliases: &["Nintendo - Family Computer Disk System"],
        extensions: &["fds"],
        core: "nestopia_libretro.so",
        audio_channels: 1,
    },
    // ── Nintendo — SNES ───────────────────────────────────────────
    PlatformManifest {
        short_name: "SNES",
        aliases: &["Nintendo - Super Nintendo Entertainment System"],
        extensions: &["sfc", "smc"],
        core: "snes9x_libretro.so",
        audio_channels: 2,
    },
    // ── Nintendo — N64 ────────────────────────────────────────────
    PlatformManifest {
        short_name: "Nintendo 64",
        aliases: &["Nintendo - Nintendo 64"],
        extensions: &["n64", "z64", "v64"],
        core: "mupen64plus_next_libretro.so",
        audio_channels: 2,
    },
    // ── Nintendo — DS ─────────────────────────────────────────────
    PlatformManifest {
        short_name: "Nintendo DS",
        aliases: &["Nintendo - Nintendo DS"],
        extensions: &["nds"],
        core: "desmume_libretro.so",
        audio_channels: 2,
    },
    // ── Nintendo — Virtual Boy ─────────────────────────────────────
    PlatformManifest {
        short_name: "Virtual Boy",
        aliases: &["Nintendo - Virtual Boy"],
        extensions: &["vb"],
        core: "mednafen_vb_libretro.so",
        audio_channels: 2,
    },
    // ── Nintendo — Pokemon Mini ────────────────────────────────────
    PlatformManifest {
        short_name: "Pokemon Mini",
        aliases: &["Nintendo - Pokemon Mini"],
        extensions: &["min"],
        core: "pokemini_libretro.so",
        audio_channels: 1,
    },
    // ── Sega — Genesis / MS / GG / CD ──────────────────────────────
    PlatformManifest {
        short_name: "Genesis",
        aliases: &["Sega - Mega Drive - Genesis"],
        extensions: &["gen", "md", "smd"],
        core: "genesis_plus_gx_libretro.so",
        audio_channels: 2,
    },
    PlatformManifest {
        short_name: "Master System",
        aliases: &["Sega - Master System - Mark III"],
        extensions: &["sms"],
        core: "genesis_plus_gx_libretro.so",
        audio_channels: 2,
    },
    PlatformManifest {
        short_name: "Game Gear",
        aliases: &["Sega - Game Gear"],
        extensions: &["gg"],
        core: "genesis_plus_gx_libretro.so",
        audio_channels: 2,
    },
    PlatformManifest {
        short_name: "Sega CD",
        aliases: &["Sega - Sega CD - Mega CD"],
        extensions: &[], // detected via dir name, not extension
        core: "genesis_plus_gx_libretro.so",
        audio_channels: 2,
    },
    // ── Sega — 32X ─────────────────────────────────────────────────
    PlatformManifest {
        short_name: "Sega 32X",
        aliases: &["Sega - Sega 32X"],
        extensions: &["32x"],
        core: "picodrive_libretro.so",
        audio_channels: 2,
    },
    // ── Sega — Saturn ──────────────────────────────────────────────
    PlatformManifest {
        short_name: "Saturn",
        aliases: &["Sega - Saturn"],
        extensions: &["mdf"],
        core: "yabause_libretro.so",
        audio_channels: 2,
    },
    // ── Sega — Dreamcast ───────────────────────────────────────────
    PlatformManifest {
        short_name: "Dreamcast",
        aliases: &["Sega - Dreamcast"],
        extensions: &["cdi", "gdi"],
        core: "flycast_libretro.so",
        audio_channels: 2,
    },
    // ── Sony — PlayStation ─────────────────────────────────────────
    PlatformManifest {
        short_name: "PlayStation",
        aliases: &["Sony - PlayStation"],
        extensions: &["iso", "cue"],
        core: "pcsx_rearmed_libretro.so",
        audio_channels: 2,
    },
    // ── Sony — PlayStation Portable ────────────────────────────────
    PlatformManifest {
        short_name: "PSP",
        aliases: &["Sony - PlayStation Portable", "PlayStation Portable"],
        extensions: &["cso"],
        core: "ppsspp_libretro.so",
        audio_channels: 2,
    },
    // ── Atari — 2600 / 5200 / 7800 / Lynx ──────────────────────────
    PlatformManifest {
        short_name: "Atari 2600",
        aliases: &["Atari - 2600"],
        extensions: &["a26"],
        core: "stella_libretro.so",
        audio_channels: 1,
    },
    PlatformManifest {
        short_name: "Atari 5200",
        aliases: &["Atari - 5200"],
        extensions: &["a52"],
        core: "a5200_libretro.so",
        audio_channels: 1,
    },
    PlatformManifest {
        short_name: "Atari 7800",
        aliases: &["Atari - 7800"],
        extensions: &["a78"],
        core: "prosystem_libretro.so",
        audio_channels: 1,
    },
    PlatformManifest {
        short_name: "Atari Lynx",
        aliases: &["Atari - Lynx"],
        extensions: &["lnx"],
        core: "handy_libretro.so",
        audio_channels: 1,
    },
    // ── NEC — PC Engine / TurboGrafx ───────────────────────────────
    PlatformManifest {
        short_name: "PC Engine",
        aliases: &[
            "NEC - PC Engine - TurboGrafx-16",
            "NEC - PC Engine CD - TurboGrafx-CD",
            "TurboGrafx-16",
            "TurboGrafx-CD",
        ],
        extensions: &["pce"],
        core: "mednafen_pce_fast_libretro.so",
        audio_channels: 2,
    },
    // ── SNK — Neo Geo Pocket / CD ──────────────────────────────────
    PlatformManifest {
        short_name: "Neo Geo Pocket",
        aliases: &["SNK - Neo Geo Pocket"],
        extensions: &["ngp"],
        core: "mednafen_ngp_libretro.so",
        audio_channels: 2,
    },
    PlatformManifest {
        short_name: "Neo Geo Pocket Color",
        aliases: &["SNK - Neo Geo Pocket Color"],
        extensions: &["ngc"],
        core: "mednafen_ngp_libretro.so",
        audio_channels: 2,
    },
    PlatformManifest {
        short_name: "Neo Geo CD",
        aliases: &["SNK - Neo Geo CD"],
        extensions: &[], // detected via dir name
        core: "neocd_libretro.so",
        audio_channels: 2,
    },
    // ── Bandai — WonderSwan ────────────────────────────────────────
    PlatformManifest {
        short_name: "WonderSwan",
        aliases: &["Bandai - WonderSwan"],
        extensions: &["ws"],
        core: "mednafen_wswan_libretro.so",
        audio_channels: 1,
    },
    PlatformManifest {
        short_name: "WonderSwan Color",
        aliases: &["Bandai - WonderSwan Color"],
        extensions: &["wsc"],
        core: "mednafen_wswan_libretro.so",
        audio_channels: 1,
    },
    // ── Arcade ────────────────────────────────────────────────────
    PlatformManifest {
        short_name: "Arcade",
        aliases: &[],
        extensions: &["zip"],
        core: "fbneo_libretro.so",
        audio_channels: 1,
    },
];

// ── Lookup helpers ──────────────────────────────────────────────────────

/// Find a platform by ROM file extension (lowercase).
pub fn by_extension(ext: &str) -> Option<&'static PlatformManifest> {
    PLATFORMS.iter().find(|p| p.extensions.contains(&ext))
}

/// Map a platform name (short name or alias) to a libretro core filename.
///
/// Returns `None` for unknown platforms so the worker can fall back
/// to test pattern.
pub fn core_for_platform(name: &str) -> Option<&'static str> {
    // Env var override takes priority
    let override_key = name.replace([' ', '-'], "_");
    let env_key = format!("GV_CORE_OVERRIDE_{override_key}");
    if let Ok(custom) = std::env::var(&env_key) {
        // Leak is intentional — the override string lives for the
        // process lifetime and is read once per worker spawn.
        return Some(Box::leak(custom.into_boxed_str()));
    }

    // Linear scan — first match wins
    for p in PLATFORMS {
        if p.short_name == name {
            return Some(p.core);
        }
        if p.aliases.contains(&name) {
            return Some(p.core);
        }
    }

    tracing::debug!("[PLATFORM] no mapping for: {name}");
    None
}

/// Map a platform name to its audio channel count (1 = mono, 2 = stereo).
///
/// Falls back to 2 (stereo) for unknown platforms — stereo is always safe
/// (mono → stereo duplication is handled by the audio pipeline).
pub fn channels_for_platform(name: &str) -> u16 {
    for p in PLATFORMS {
        if p.short_name == name {
            return p.audio_channels;
        }
        if p.aliases.contains(&name) {
            return p.audio_channels;
        }
    }
    2 // fallback: assume stereo for unknown platforms
}

/// Find the DAT system name (first alias) for a file extension.
///
/// Used by the DAT module to locate the correct `.dat` file on GitHub.
pub fn dat_system_name(ext: &str) -> Option<&'static str> {
    PLATFORMS
        .iter()
        .find(|p| p.extensions.contains(&ext))
        .and_then(|p| p.aliases.first().copied())
}

/// Peek inside a .zip file and return the extension of the first entry
/// that maps to a known ROM platform. Returns `None` if the zip can't be
/// read, is empty, or contains only entries with unrecognised extensions
/// (typical of MAME / FBNeo arcade ROMs).
fn peek_zip_extension(path: &std::path::Path) -> Option<String> {
    let file = std::fs::File::open(path).ok()?;
    let mut archive = zip::ZipArchive::new(std::io::BufReader::new(file)).ok()?;

    for i in 0..archive.len() {
        let entry = archive.by_index(i).ok()?;
        // Skip directories
        if entry.is_dir() {
            continue;
        }
        let name = entry.name();
        let inner_path = std::path::Path::new(name);
        if let Some(ext) = inner_path.extension().and_then(|e| e.to_str()) {
            let ext_lower = ext.to_lowercase();
            if by_extension(&ext_lower).is_some() {
                return Some(ext_lower);
            }
        }
    }

    None
}

/// Detect a platform name from a file path.
///
/// For `.zip` files, peeks inside to find a known ROM extension before
/// falling back. Otherwise tries the extension first, then parent directory
/// name (RetroArch-style: "Nintendo - Game Boy" → "Game Boy").
pub fn detect_platform_name(path: &std::path::Path) -> Option<String> {
    let ext = path.extension()?.to_str()?.to_lowercase();

    // ── .zip files: inspect contents ──────────────────────────────────
    if ext == "zip" {
        // Try inner extension first (e.g. game.zip containing game.nes → NES)
        if let Some(inner_ext) = peek_zip_extension(path) {
            if let Some(pm) = by_extension(&inner_ext) {
                return Some(pm.short_name.to_string());
            }
        }
        // Fallback: parent directory name
        let parent = path.parent()?.file_name()?.to_str()?;
        if let Some(system) = parent.split(" - ").nth(1) {
            if let Some(pm) = PLATFORMS
                .iter()
                .find(|p| p.short_name == system || p.aliases.contains(&system))
            {
                return Some(pm.short_name.to_string());
            }
        }
        // Last resort — assume Arcade (FBNeo)
        return Some("Arcade".to_string());
    }

    // ── Normal extension-based detection ──────────────────────────────
    if let Some(pm) = by_extension(&ext) {
        return Some(pm.short_name.to_string());
    }

    // Fallback: parent directory name
    let parent = path.parent()?.file_name()?.to_str()?;
    if let Some(system) = parent.split(" - ").nth(1) {
        if let Some(pm) = PLATFORMS
            .iter()
            .find(|p| p.short_name == system || p.aliases.contains(&system))
        {
            return Some(pm.short_name.to_string());
        }
    }

    None
}

// ── Tests ──────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    // ── Extension detection ────────────────────────────────────────

    #[test]
    fn detect_platform_from_extension() {
        assert_eq!(
            detect_platform_name(std::path::Path::new("/roms/game.sfc")),
            Some("SNES".into())
        );
        assert_eq!(
            detect_platform_name(std::path::Path::new("/roms/game.nes")),
            Some("NES".into())
        );
        assert_eq!(
            detect_platform_name(std::path::Path::new("/roms/game.gba")),
            Some("Game Boy Advance".into())
        );
    }

    #[test]
    fn detect_platform_falls_back_to_dir_name() {
        assert_eq!(
            detect_platform_name(std::path::Path::new("/roms/Nintendo - Game Boy/game.gb")),
            Some("Game Boy".into())
        );
    }

    #[test]
    fn detect_platform_unknown_extension() {
        assert_eq!(
            detect_platform_name(std::path::Path::new("/roms/game.xyz")),
            None
        );
    }

    // ── Core mapping ───────────────────────────────────────────────

    #[test]
    fn core_by_short_name() {
        assert_eq!(core_for_platform("NES"), Some("nestopia_libretro.so"));
        assert_eq!(core_for_platform("SNES"), Some("snes9x_libretro.so"));
        assert_eq!(core_for_platform("Game Boy"), Some("sameboy_libretro.so"));
        assert_eq!(
            core_for_platform("Game Boy Advance"),
            Some("mgba_libretro.so")
        );
    }

    #[test]
    fn core_by_dat_name() {
        assert_eq!(
            core_for_platform("Nintendo - Nintendo Entertainment System"),
            Some("nestopia_libretro.so")
        );
        assert_eq!(
            core_for_platform("Nintendo - Super Nintendo Entertainment System"),
            Some("snes9x_libretro.so")
        );
    }

    #[test]
    fn core_unknown_platform() {
        assert_eq!(core_for_platform("Nintendo GameCube"), None);
    }

    /// First-match-wins: "Game Boy Advance" must not match "Game Boy".
    #[test]
    fn specific_platform_matches_before_broad() {
        assert_eq!(
            core_for_platform("Game Boy Advance"),
            Some("mgba_libretro.so")
        );
        assert_eq!(core_for_platform("Game Boy"), Some("sameboy_libretro.so"));
    }

    // ── Coverage ───────────────────────────────────────────────────

    /// Every platform in the manifest that has extensions must have
    /// a core mapping (redundant since core is mandatory on the struct,
    /// but validates no accidental `""` cores).
    #[test]
    fn every_platform_with_extensions_has_core() {
        let missing: Vec<_> = PLATFORMS
            .iter()
            .filter(|p| !p.extensions.is_empty() && p.core.is_empty())
            .map(|p| p.short_name)
            .collect();
        assert!(
            missing.is_empty(),
            "platforms with extensions but no core: {missing:?}"
        );
    }

    /// Full RetroArch DAT platform names covered.
    #[test]
    fn retroarch_dat_platforms_have_mapping() {
        let dat_platforms = &[
            "Nintendo - Game Boy",
            "Nintendo - Game Boy Color",
            "Nintendo - Game Boy Advance",
            "Nintendo - Nintendo Entertainment System",
            "Nintendo - Family Computer Disk System",
            "Nintendo - Super Nintendo Entertainment System",
            "Nintendo - Nintendo 64",
            "Nintendo - Nintendo DS",
            "Nintendo - Virtual Boy",
            "Nintendo - Pokemon Mini",
            "Sega - Mega Drive - Genesis",
            "Sega - Master System - Mark III",
            "Sega - Game Gear",
            "Sega - Sega CD - Mega CD",
            "Sega - Sega 32X",
            "Sega - Saturn",
            "Sega - Dreamcast",
            "Sony - PlayStation",
            "Sony - PlayStation Portable",
            "Atari - 2600",
            "Atari - 5200",
            "Atari - 7800",
            "Atari - Lynx",
            "NEC - PC Engine - TurboGrafx-16",
            "NEC - PC Engine CD - TurboGrafx-CD",
            "SNK - Neo Geo Pocket",
            "SNK - Neo Geo Pocket Color",
            "SNK - Neo Geo CD",
            "Bandai - WonderSwan",
            "Bandai - WonderSwan Color",
            "Arcade",
        ];

        let missing: Vec<_> = dat_platforms
            .iter()
            .filter(|p| core_for_platform(p).is_none())
            .collect();

        assert!(
            missing.is_empty(),
            "DAT platforms without core mappings: {missing:?}"
        );
    }

    /// DAT system name lookup matches the old `DAT_SYSTEM_NAMES`.
    #[test]
    fn dat_system_name_by_extension() {
        assert_eq!(dat_system_name("gb"), Some("Nintendo - Game Boy"));
        assert_eq!(dat_system_name("gba"), Some("Nintendo - Game Boy Advance"));
        assert_eq!(
            dat_system_name("nes"),
            Some("Nintendo - Nintendo Entertainment System")
        );
        assert_eq!(dat_system_name("gen"), Some("Sega - Mega Drive - Genesis"));
        assert_eq!(dat_system_name("xyz"), None);
    }

    /// Every platform alias must resolve to a core.
    #[test]
    fn every_alias_has_core() {
        for p in PLATFORMS {
            for alias in p.aliases {
                assert!(
                    core_for_platform(alias).is_some(),
                    "alias '{alias}' has no core mapping"
                );
            }
        }
    }

    /// No duplicate short names.
    #[test]
    fn no_duplicate_short_names() {
        let mut seen = std::collections::HashSet::new();
        for p in PLATFORMS {
            assert!(
                seen.insert(p.short_name),
                "duplicate short_name: {}",
                p.short_name
            );
        }
    }

    /// .zip files containing a known ROM should detect the inner platform.
    #[test]
    fn detect_platform_from_zip_contents() {
        use std::io::Write;

        let tmp = tempfile::tempdir().unwrap();
        let zip_path = tmp.path().join("game.zip");

        // Build a tiny zip with a .nes file inside
        let file = std::fs::File::create(&zip_path).unwrap();
        let mut archive = zip::ZipWriter::new(file);
        let options =
            zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
        archive.start_file("Super Mario Bros.nes", options).unwrap();
        archive.write_all(b"fake rom content").unwrap();
        archive.finish().unwrap();

        assert_eq!(
            detect_platform_name(&zip_path),
            Some("NES".into())
        );
    }

    /// .zip with no known inner extension → falls back to parent dir, then Arcade.
    #[test]
    fn detect_platform_from_zip_mame_style() {
        use std::io::Write;

        let tmp = tempfile::tempdir().unwrap();
        let zip_path = tmp.path().join("sf2.zip");

        // MAME-style zip: raw bin files with numeric extensions
        let file = std::fs::File::create(&zip_path).unwrap();
        let mut archive = zip::ZipWriter::new(file);
        let options =
            zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
        archive.start_file("sf2.03", options).unwrap();
        archive.write_all(b"fake").unwrap();
        archive.finish().unwrap();

        // No known inner extension, no RetroArch-style parent dir → Arcade
        assert_eq!(
            detect_platform_name(&zip_path),
            Some("Arcade".into())
        );
    }
}
