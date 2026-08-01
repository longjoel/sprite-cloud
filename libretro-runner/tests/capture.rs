//! End-to-end bounded still capture against the trusted no-content 2048 core.

use std::fs;
use std::io::BufReader;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

use libretro_runner::{CaptureConfig, capture_still};

fn libretro_test_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

fn workspace_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("workspace root")
        .to_path_buf()
}

fn fixture_core() -> PathBuf {
    std::env::var_os("TEST_LIBRETRO_CORE")
        .map(PathBuf::from)
        .unwrap_or_else(|| workspace_root().join("test-data/cores/2048_libretro.so"))
}

#[test]
fn capture_still_writes_a_complete_png_from_a_software_framebuffer_core() {
    let _guard = libretro_test_lock().lock().expect("libretro test lock");
    let core = fixture_core();
    assert!(
        core.exists(),
        "missing fixture core {}; set TEST_LIBRETRO_CORE",
        core.display()
    );

    let output_dir = tempfile::tempdir().expect("temporary output directory");
    let output = output_dir.path().join("cover.png");
    let system_dir = output_dir.path().join("system");

    let captured = capture_still(CaptureConfig {
        core_path: core,
        content_path: None,
        system_dir,
        output_path: output.clone(),
        frame_budget: 120,
        max_wall_time: std::time::Duration::from_secs(5),
    })
    .expect("capture should succeed");

    assert!(captured.width > 0 && captured.height > 0);
    assert!(captured.width <= 512 && captured.height <= 480);
    assert_eq!(captured.path, output);

    let bytes = fs::read(&output).expect("PNG artifact should exist");
    assert!(
        bytes.starts_with(b"\x89PNG\r\n\x1a\n"),
        "artifact must be PNG"
    );

    let decoder = png::Decoder::new(BufReader::new(bytes.as_slice()));
    let reader = decoder.read_info().expect("PNG must decode");
    let info = reader.info();
    assert_eq!((info.width, info.height), (captured.width, captured.height));
}

#[test]
fn capture_still_times_out_without_creating_a_final_artifact() {
    let _guard = libretro_test_lock().lock().expect("libretro test lock");
    let core = fixture_core();
    assert!(
        core.exists(),
        "missing fixture core {}; set TEST_LIBRETRO_CORE",
        core.display()
    );

    let output_dir = tempfile::tempdir().expect("temporary output directory");
    let output = output_dir.path().join("cover.png");
    let error = capture_still(CaptureConfig {
        core_path: core,
        content_path: None,
        system_dir: output_dir.path().join("system"),
        output_path: output.clone(),
        frame_budget: 120,
        max_wall_time: std::time::Duration::from_nanos(1),
    })
    .expect_err("an expired wall-time budget must fail");

    assert!(error.to_string().contains("capture exceeded"));
    assert!(
        !output.exists(),
        "timed-out captures must not leave a final artifact"
    );
}

#[test]
fn capture_still_does_not_leave_a_partial_artifact_when_the_core_cannot_load() {
    let _guard = libretro_test_lock().lock().expect("libretro test lock");
    let output_dir = tempfile::tempdir().expect("temporary output directory");
    let output = output_dir.path().join("cover.png");

    let error = capture_still(CaptureConfig {
        core_path: output_dir.path().join("missing-core.so"),
        content_path: None,
        system_dir: output_dir.path().join("system"),
        output_path: output.clone(),
        frame_budget: 1,
        max_wall_time: std::time::Duration::from_secs(1),
    })
    .expect_err("missing core must fail");

    assert!(error.to_string().contains("failed to load core"));
    assert!(
        !output.exists(),
        "failed captures must not leave a final artifact"
    );
}
