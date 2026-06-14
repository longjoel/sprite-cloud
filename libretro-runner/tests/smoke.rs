//! Integration test — loads a real libretro core and verifies AV info.
//!
//! Set `TEST_LIBRETRO_CORE` to the path of a libretro .so to run.
//! The 2048 core at `test-data/cores/2048_libretro.so` works without a ROM.
//!
//! Run: `cargo test -p libretro-runner --test smoke -- --nocapture`

use std::path::PathBuf;

use libretro_runner::{Core, CoreConfig};

#[test]
fn load_2048_core() {
    let core_path = std::env::var("TEST_LIBRETRO_CORE").unwrap_or_else(|_| {
        // Default to the built 2048 core — resolve relative to workspace root
        let workspace_root = std::env::var("CARGO_MANIFEST_DIR")
            .map(|d| PathBuf::from(d).parent().unwrap().to_path_buf())
            .unwrap_or_else(|_| PathBuf::from("."));
        workspace_root
            .join("test-data/cores/2048_libretro.so")
            .to_string_lossy()
            .to_string()
    });

    let core_path = PathBuf::from(&core_path);
    if !core_path.exists() {
        eprintln!(
            "SKIP: core not found at {} — set TEST_LIBRETRO_CORE or build the 2048 core",
            core_path.display()
        );
        return;
    }

    // SAFETY: the 2048 core is a trusted libretro implementation.
    // No ROM needed — 2048 declares SET_SUPPORT_NO_GAME.
    let core = unsafe {
        Core::load(CoreConfig {
            core_path: core_path.clone(),
            content_path: None,
            system_dir: "/tmp".into(),
            save_dir: "/tmp".into(),
        })
    };

    match core {
        Ok(core) => {
            let info = &core.av_info;
            assert!(info.base_width > 0, "base_width should be positive");
            assert!(info.base_height > 0, "base_height should be positive");
            assert!(info.fps > 0.0, "fps should be positive");
            // sample_rate may be 0 for cores without audio (e.g. 2048)
            assert!(info.sample_rate >= 0.0, "sample_rate should not be negative");

            println!(
                "2048 core loaded: {}x{} @ {:.1}fps, {:.0}Hz",
                info.base_width, info.base_height, info.fps, info.sample_rate
            );
        }
        Err(e) => {
            panic!("Failed to load 2048 core at {}: {}", core_path.display(), e);
        }
    }
}
