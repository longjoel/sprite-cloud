//! Integration tests for automatic core download (#195).

/// `ensure_core` must skip download when the .so already exists.
#[tokio::test]
async fn ensure_core_skips_when_cached() {
    let tmp = tempfile::tempdir().unwrap();
    let core_path = tmp.path().join("fake_libretro.so");
    std::fs::write(&core_path, b"fake").unwrap();

    unsafe {
        std::env::set_var("GV_CORES_DIR", tmp.path().to_string_lossy().to_string());
    }

    let client = reqwest::Client::new();
    let result =
        gv_server::core_bridge::ensure_core("fake_libretro.so", &client).await;
    assert!(result.is_ok(), "expected Ok, got {:?}", result.err());
    assert_eq!(result.unwrap(), core_path);
}

/// `ensure_core` must fail gracefully for a nonexistent core
/// (buildbot 404s on unknown cores). No corrupt file must be left behind.
#[tokio::test]
async fn ensure_core_download_fails_for_unknown_core() {
    let tmp = tempfile::tempdir().unwrap();
    unsafe {
        std::env::set_var("GV_CORES_DIR", tmp.path().to_string_lossy().to_string());
    }

    let client = reqwest::Client::new();
    let result = gv_server::core_bridge::ensure_core(
        "definitely_not_a_real_core_libretro.so",
        &client,
    )
    .await;
    assert!(result.is_err(), "expected Err for unknown core");
    assert!(
        !tmp.path()
            .join("definitely_not_a_real_core_libretro.so")
            .exists(),
        "failed download must not leave a corrupt file"
    );
    // .tmp file should also be cleaned up (rename only happens on success)
    assert!(
        !tmp.path()
            .join("definitely_not_a_real_core_libretro.tmp")
            .exists(),
        "failed download must not leave a temp file"
    );
}
