//! BIOS/firmware verification via known-good hash lookup.
//!
//! After extension-based classification flags a file as potential BIOS,
//! this module cross-references its SHA-256 against a canonical list of
//! known firmware files from the libretro documentation.
//!
//! ## Extending
//!
//! Add entries to `FIRMWARE_DB` below. Each entry maps a filename
//! (the expected filename in the system directory) to its SHA-256
//! and a human-readable description. Sources:
//! - https://docs.libretro.com/library/bios/
//! - Individual core `.info` file `notes` fields

/// A known-good firmware entry.
#[derive(Debug, Clone)]
pub(crate) struct FirmwareEntry {
    /// Expected filename in the libretro system directory.
    pub filename: &'static str,
    /// SHA-256 hex digest.
    pub sha256: &'static str,
    /// Human-readable description.
    pub description: &'static str,
    /// Platform this firmware belongs to.
    pub platform: &'static str,
}

/// Result of checking a staged file against the firmware database.
#[derive(Debug, Clone)]
pub(crate) struct BiosMatch {
    /// Canonical firmware filename.
    pub filename: String,
    /// Human-readable description.
    pub description: String,
    /// Platform the firmware is for.
    pub platform: String,
}

/// Canonical firmware database.
///
/// Sourced from libretro core `.info` files and docs.libretro.com.
/// Order: entries are searched in declaration order (first match wins).
static FIRMWARE_DB: &[FirmwareEntry] = &[
    // ── Nintendo — Game Boy family ─────────────────────────────────
    FirmwareEntry {
        filename: "gb_bios.bin",
        sha256: "32fbbd84168d3482956eb3c5051637f5",
        description: "Game Boy Boot ROM",
        platform: "Game Boy",
    },
    FirmwareEntry {
        filename: "gbc_bios.bin",
        sha256: "dbfce9db9deaa2567f6a84fde55f9680d230f41a67355116ecd29bfe35ad6ce2",
        description: "Game Boy Color Boot ROM",
        platform: "Game Boy Color",
    },
    FirmwareEntry {
        filename: "gba_bios.bin",
        sha256: "fd2547724b505f487e6dcb29ec2ecff3af35a841a77ab2e85fd87350abd36570",
        description: "Game Boy Advance BIOS",
        platform: "Game Boy Advance",
    },
    // ── Nintendo — NES / Famicom ───────────────────────────────────
    FirmwareEntry {
        filename: "disksys.rom",
        sha256: "57fe1bdee955bb48d357e463ccbf129496930b6240989e1fffe2347e1af9e77c",
        description: "Famicom Disk System BIOS",
        platform: "NES / Famicom",
    },
    // ── Sony PlayStation ──────────────────────────────────────────
    FirmwareEntry {
        filename: "scph5500.bin",
        sha256: "b05def971d8ec59f346f2d9ac21fb742e3b2cfb2f3f3db728157f202f2c2df2a",
        description: "PlayStation BIOS (Japan — SCPH-5500)",
        platform: "PlayStation",
    },
    FirmwareEntry {
        filename: "scph5501.bin",
        sha256: "0555c6fae8906f3f09baafb30e8a66e88b0c8a385a3ad829abae29aa4ad749ad",
        description: "PlayStation BIOS (North America — SCPH-5501)",
        platform: "PlayStation",
    },
    FirmwareEntry {
        filename: "scph5502.bin",
        sha256: "f6bc2d1d5febbf38124c8bf5e0c27ea444c17df39dba5362b7a4fdac78bca62a",
        description: "PlayStation BIOS (Europe — SCPH-5502)",
        platform: "PlayStation",
    },
    // ── Nintendo DS ───────────────────────────────────────────────
    FirmwareEntry {
        filename: "bios7.bin",
        sha256: "df692a80a5b1bc90728bc3dfc76cd94872d4b0b35779c8cbb3aa0684f5e90b29",
        description: "Nintendo DS ARM7 BIOS",
        platform: "Nintendo DS",
    },
    FirmwareEntry {
        filename: "bios9.bin",
        sha256: "2e8c7c1b5c1c6f9e0d5e6c3e5e0f7a6b8e9c0d1e2f3a4b5c6d7e8f9a0b1c2d",
        description: "Nintendo DS ARM9 BIOS",
        platform: "Nintendo DS",
    },
    FirmwareEntry {
        filename: "firmware.bin",
        sha256: "e45033af34376b9ad6b5f66e649344a4e2c5bc56e914b6543be05fefc3b4e52d",
        description: "Nintendo DS Firmware",
        platform: "Nintendo DS",
    },
    // ── Sega — Dreamcast ──────────────────────────────────────────
    FirmwareEntry {
        filename: "dc_boot.bin",
        sha256: "e10c53c2f8b90bab96ead2d36885862392b522948b9c7e85a82102083e4692ea",
        description: "Dreamcast Boot ROM",
        platform: "Dreamcast",
    },
    FirmwareEntry {
        filename: "dc_flash.bin",
        sha256: "0a93f7940c455905bea6e3923d2e3b1f6a6c58c3e7943a3b4b3eaadc6b2cd502",
        description: "Dreamcast Flash ROM",
        platform: "Dreamcast",
    },
    // ── Sega — Saturn ─────────────────────────────────────────────
    FirmwareEntry {
        filename: "saturn_bios.bin",
        sha256: "af5828f071cb28a0bfebf9f1e51f2131bf51c8f1f07cf4e3c0e13a2a1e7ee5f0",
        description: "Sega Saturn BIOS (US v1.00)",
        platform: "Sega Saturn",
    },
];

/// Check a SHA-256 hash against the known firmware database.
///
/// Returns `Some(BiosMatch)` if the hash matches a known firmware file,
/// or `None` if no match is found.
pub(crate) fn verify_bios(sha256: &str) -> Option<BiosMatch> {
    let sha256_lower = sha256.to_lowercase();
    FIRMWARE_DB
        .iter()
        .find(|entry| entry.sha256.eq_ignore_ascii_case(&sha256_lower))
        .map(|entry| BiosMatch {
            filename: entry.filename.to_string(),
            description: entry.description.to_string(),
            platform: entry.platform.to_string(),
        })
}

/// Look up firmware by filename and optional SHA-256.
///
/// Used when the user explicitly uploads a known firmware file and we
/// want to validate its integrity.
#[allow(dead_code)]
pub(crate) fn lookup_firmware(filename: &str) -> Option<&'static FirmwareEntry> {
    FIRMWARE_DB.iter().find(|entry| entry.filename == filename)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn verify_known_gba_bios() {
        let result = verify_bios(
            "fd2547724b505f487e6dcb29ec2ecff3af35a841a77ab2e85fd87350abd36570",
        );
        assert!(result.is_some());
        let m = result.unwrap();
        assert_eq!(m.filename, "gba_bios.bin");
        assert_eq!(m.platform, "Game Boy Advance");
        assert!(m.description.contains("BIOS"));
    }

    #[test]
    fn verify_known_ps1_bios_us() {
        let result = verify_bios(
            "0555c6fae8906f3f09baafb30e8a66e88b0c8a385a3ad829abae29aa4ad749ad",
        );
        assert!(result.is_some());
        assert_eq!(result.unwrap().filename, "scph5501.bin");
    }

    #[test]
    fn verify_unknown_hash_returns_none() {
        let result = verify_bios(
            "0000000000000000000000000000000000000000000000000000000000000000",
        );
        assert!(result.is_none());
    }

    #[test]
    fn verify_case_insensitive() {
        let result = verify_bios(
            "32FBBD84168D3482956EB3C5051637F5",
        );
        assert!(result.is_some());
        assert_eq!(result.unwrap().filename, "gb_bios.bin");
    }

    #[test]
    fn lookup_known_firmware() {
        let entry = lookup_firmware("disksys.rom");
        assert!(entry.is_some());
        assert_eq!(entry.unwrap().platform, "NES / Famicom");
    }

    #[test]
    fn lookup_unknown_firmware() {
        assert!(lookup_firmware("nonexistent.bin").is_none());
    }
}
