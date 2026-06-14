//! Integration test — loads a real libretro core, runs frames,
//! and verifies video output.
//!
//! Set `TEST_LIBRETRO_CORE` to the path of a libretro .so to run.
//! The 2048 core at `test-data/cores/2048_libretro.so` works without a ROM.
//!
//! Run: `cargo test -p libretro-runner --test smoke -- --nocapture`

use std::path::PathBuf;

use libretro_runner::{Core, CoreConfig, JoypadButton};

#[test]
fn load_and_run_2048_core() {
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
    let mut core = unsafe {
        Core::load(CoreConfig {
            core_path: core_path.clone(),
            content_path: None,
            system_dir: "/tmp".into(),
            save_dir: "/tmp".into(),
        })
    }
    .unwrap_or_else(|e| panic!("Failed to load 2048 core at {}: {}", core_path.display(), e));

    // Copy AV info values before we mutably borrow core for run_frame()
    let base_w = core.av_info.base_width;
    let base_h = core.av_info.base_height;
    let fps = core.av_info.fps;
    let sample_rate = core.av_info.sample_rate;

    assert!(base_w > 0, "base_width should be positive, got {}", base_w);
    assert!(base_h > 0, "base_height should be positive, got {}", base_h);
    assert!(fps > 0.0, "fps should be positive, got {}", fps);
    assert!(sample_rate >= 0.0, "sample_rate should not be negative");

    println!(
        "2048 core loaded: {}x{} @ {:.1}fps, {:.0}Hz",
        base_w, base_h, fps, sample_rate
    );

    // Run a few frames — 2048 needs a few to initialize its grid
    let mut frames_with_output = 0u32;
    let mut first_frame_dims = None;

    for i in 0..120 {
        core.run_frame()
            .unwrap_or_else(|e| panic!("run_frame failed on frame {}: {}", i, e));

        if let Some(frame) = core.frame() {
            frames_with_output += 1;
            let (w, h) = core.frame_size();

            if first_frame_dims.is_none() {
                first_frame_dims = Some((w, h));
            }

            // Verify frame size matches dimensions × 3 bytes (RGB24)
            let expected_size = (w as usize) * (h as usize) * 3;
            assert_eq!(
                frame.len(),
                expected_size,
                "frame {} has wrong size: {} bytes for {}x{} (expected {})",
                i,
                frame.len(),
                w,
                h,
                expected_size
            );

            // Verify it's not all black — 2048 draws a colored grid
            let non_zero = frame.iter().filter(|&&b| b > 0).count();
            assert!(
                non_zero > 0,
                "frame {} is all black — 2048 should be drawing something",
                i
            );
        }
    }

    let (fw, fh) = first_frame_dims.expect("should have at least one frame");
    assert_eq!(fw, base_w, "frame width should match av_info");
    assert_eq!(fh, base_h, "frame height should match av_info");

    println!(
        "Frames: {}/120 produced output. First frame: {}x{}, {} bytes (RGB24). All good.",
        frames_with_output,
        fw,
        fh,
        fw as usize * fh as usize * 3
    );

    // ---- Test input: pressing Start then Up should change game state ----
    // Press Start to skip any intro screen
    core.set_joypad(0, JoypadButton::Start, true);
    core.run_frame().unwrap();
    core.set_joypad(0, JoypadButton::Start, false);
    // Run a few frames to let the game settle
    for _ in 0..10 {
        core.run_frame().unwrap();
    }

    // Baseline: capture a frame with no input
    core.run_frame().unwrap();
    let before = core.frame().unwrap().to_vec();

    // Hold Up for 5 frames (2048 needs held input)
    core.set_joypad(0, JoypadButton::Up, true);
    for _ in 0..5 {
        core.run_frame().unwrap();
    }
    let during = core.frame().unwrap().to_vec();
    core.set_joypad(0, JoypadButton::Up, false);

    // Release and run a few frames
    for _ in 0..10 {
        core.run_frame().unwrap();
    }
    core.run_frame().unwrap();
    let after = core.frame().unwrap().to_vec();

    // The frame during Up hold should differ from baseline
    let before_hash: u64 = before.iter().fold(0, |h, &b| h.wrapping_mul(31).wrapping_add(b as u64));
    let during_hash: u64 = during.iter().fold(0, |h, &b| h.wrapping_mul(31).wrapping_add(b as u64));
    let after_hash: u64 = after.iter().fold(0, |h, &b| h.wrapping_mul(31).wrapping_add(b as u64));

    // At least one of during/after should differ from baseline
    // (the game might not respond on frame-perfect input, or might have
    // a different button layout)
    let input_changed = before_hash != during_hash || before_hash != after_hash;

    if !input_changed {
        // Try Right as well — some 2048 builds map differently
        core.set_joypad(0, JoypadButton::Right, true);
        for _ in 0..5 {
            core.run_frame().unwrap();
        }
        let right_frame = core.frame().unwrap().to_vec();
        let right_hash: u64 = right_frame
            .iter()
            .fold(0, |h, &b| h.wrapping_mul(31).wrapping_add(b as u64));
        core.set_joypad(0, JoypadButton::Right, false);

        let right_changed = before_hash != right_hash;

        assert!(
            right_changed,
            "Neither Up nor Right input changed the frame.              before={}, during={}, after={}, right={}",
            before_hash, during_hash, after_hash, right_hash
        );

        println!(
            "Input test: Up didn't change, but Right did — before={}, right={}",
            before_hash, right_hash
        );
    } else {
        println!(
            "Input test: before={}, during={}, after={} — input changes verified",
            before_hash, during_hash, after_hash
        );
    }
}
