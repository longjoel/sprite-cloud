# Automatic Core Download (Buildbot Pull)

> **For Hermes:** Implement task-by-task. Each task is self-contained.  
> **Refs:** #194

**Goal:** When a game is launched and the required libretro core isn't installed, download it automatically from the libretro buildbot.

**Architecture:** gv-server checks if the core `.so` exists before spawning the worker. If missing, it downloads the `.zip` from `https://buildbot.libretro.com/nightly/linux/x86_64/latest/`, extracts the `.so`, caches it locally, then proceeds. Concurrent downloads of the same core are serialized. Download failures fall back to test pattern (worker handles this gracefully).

**Tech Stack:** Rust (tokio, reqwest, zip crate), libretro buildbot nightly channel

---

## Security model

| Threat | Mitigation | Where |
|---|---|---|
| Malicious buildbot URL (MITM) | HTTPS only, configurable `GV_BUILDBOT_URL` for mirrors | Task 2 |
| Concurrent duplicate downloads | `Mutex<HashSet>` of in-flight core names | Task 2 |
| Corrupt zip / disk full | Extraction failure → delete partial → fall back to test pattern | Task 3 |
| Core hides in subdirectory within zip | Assert zip has exactly 1 `.so` file at root; reject otherwise | Task 4 |

---

## Task List

### Task 1: Add `reqwest` and `zip` dependencies to gv-server

**Files:** `gv-server/Cargo.toml`

Add:
```toml
reqwest = { version = "0.12", features = ["rustls-tls"], default-features = false }
zip = "2.2"
```

**Verify:** `cargo check -p gv-server` compiles with new deps.

---

### Task 2: Add `download_core()` function to `worker.rs`

**Files:** `gv-server/src/worker.rs`

Add a new function after the existing core helpers. It downloads + extracts a core `.so` from the buildbot.

```rust
use std::collections::HashSet;
use std::io;
use std::sync::Mutex;

/// Base URL for libretro buildbot nightly core downloads.
/// Override via `GV_BUILDBOT_URL` env var.
static BUILDBOT_BASE: std::sync::LazyLock<String> = std::sync::LazyLock::new(|| {
    std::env::var("GV_BUILDBOT_URL")
        .unwrap_or_else(|_| "https://buildbot.libretro.com/nightly/linux/x86_64/latest".into())
});

/// Set of core filenames currently being downloaded.
/// Prevents concurrent duplicate downloads.
static DOWNLOADING: std::sync::LazyLock<Mutex<HashSet<String>>> =
    std::sync::LazyLock::new(|| Mutex::new(HashSet::new()));

/// Ensure a core `.so` file exists in the cores directory.
///
/// If the file is already present, returns its path immediately.
/// Otherwise downloads it from the buildbot, extracts it, and
/// returns the path.  Concurrent calls for the same core wait
/// for the first download to finish.
async fn ensure_core(
    core_filename: &str,
    client: &reqwest::Client,
) -> Result<PathBuf, String> {
    let core_path = resolve_core_path(core_filename);

    // Fast path: already cached
    if core_path.exists() {
        return Ok(core_path);
    }

    // Serialize downloads of the same core
    {
        let mut inflight = DOWNLOADING.lock().map_err(|e| format!("lock poisoned: {e}"))?;
        if inflight.contains(core_filename) {
            drop(inflight);
            // Another task is downloading — poll until the file appears
            for _ in 0..60 {
                tokio::time::sleep(std::time::Duration::from_secs(1)).await;
                if core_path.exists() {
                    return Ok(core_path);
                }
            }
            return Err("timed out waiting for concurrent core download".into());
        }
        inflight.insert(core_filename.to_string());
    }

    // Download + extract
    let result = download_and_extract(core_filename, &core_path, client).await;

    // Remove from in-flight set
    {
        let mut inflight = DOWNLOADING.lock().map_err(|_| "lock poisoned")?;
        inflight.remove(core_filename);
    }

    result.map(|()| core_path)
}

/// Download a core zip from the buildbot and extract the `.so` file.
async fn download_and_extract(
    core_filename: &str,
    core_path: &PathBuf,
    client: &reqwest::Client,
) -> Result<(), String> {
    let zip_name = format!("{core_filename}.zip");
    let url = format!("{}/{}", *BUILDBOT_BASE, zip_name);

    tracing::info!("[CORE] downloading {url}");

    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("download {url}: {e}"))?;

    if !resp.status().is_success() {
        return Err(format!("download {url}: HTTP {}", resp.status()));
    }

    let bytes = resp
        .bytes()
        .await
        .map_err(|e| format!("read body: {e}"))?;

    // Extract the single .so file
    let cursor = io::Cursor::new(bytes.as_ref());
    let mut archive = zip::ZipArchive::new(cursor)
        .map_err(|e| format!("open zip: {e}"))?;

    if archive.len() != 1 {
        return Err(format!(
            "expected 1 file in {zip_name}, got {}",
            archive.len()
        ));
    }

    let mut entry = archive.by_index(0).map_err(|e| format!("read zip entry: {e}"))?;
    let name = entry.name().to_string();

    if !name.ends_with(".so") || name.contains('/') {
        return Err(format!(
            "unexpected file in {zip_name}: {name} (expected {core_filename})"
        ));
    }

    // Ensure parent directory exists
    if let Some(parent) = core_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("create cores dir: {e}"))?;
    }

    // Write to a temp file first, then rename atomically
    let tmp_path = core_path.with_extension("tmp");
    let mut out = std::fs::File::create(&tmp_path)
        .map_err(|e| format!("create {tmp_path:?}: {e}"))?;
    io::copy(&mut entry, &mut out)
        .map_err(|e| format!("extract {name}: {e}"))?;
    drop(out);

    // Make executable
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&tmp_path, std::fs::Permissions::from_mode(0o755))
            .map_err(|e| format!("chmod +x {tmp_path:?}: {e}"))?;
    }

    std::fs::rename(&tmp_path, core_path)
        .map_err(|e| format!("rename {tmp_path:?} → {core_path:?}: {e}"))?;

    let size = std::fs::metadata(core_path)
        .map(|m| m.len())
        .unwrap_or(0);
    tracing::info!(
        "[CORE] installed {} ({} bytes)",
        core_path.display(),
        size
    );

    Ok(())
}
```

**Verify:** `cargo check -p gv-server`

---

### Task 3: Call `ensure_core()` in `spawn_worker()`

**Files:** `gv-server/src/worker.rs`

In `spawn_worker()`, after the core mapping block (where `GV_CORE_PATH` is currently set), wrap it in an `ensure_core()` call:

Replace the current block (lines ~250-260):
```rust
    // Map platform to a libretro core and pass it to the worker
    if let Some(plat) = platform {
        if let Some(core_file) = core_for_platform(plat) {
            let core_path = resolve_core_path(&core_file);
            tracing::info!(
                "[WORKER] platform={plat} → core={core_file} ({})",
                core_path.display()
            );
            cmd.env("GV_CORE_PATH", core_path);
        }
    }
```

With:
```rust
    // Map platform to a libretro core — download if missing
    if let Some(plat) = platform {
        if let Some(core_file) = core_for_platform(plat) {
            // Build an HTTP client for core downloads
            let dl_client = reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(120))
                .build()
                .unwrap_or_default();

            match ensure_core(&core_file, &dl_client).await {
                Ok(core_path) => {
                    tracing::info!(
                        "[WORKER] platform={plat} → core={core_file} ({})",
                        core_path.display()
                    );
                    cmd.env("GV_CORE_PATH", core_path);
                }
                Err(e) => {
                    tracing::warn!(
                        "[WORKER] core download failed for {core_file}: {e} — worker will use test pattern"
                    );
                }
            }
        }
    }
```

Add `reqwest` import at the top of `worker.rs`:
```rust
use reqwest;
```

**Verify:** `cargo check -p gv-server`

---

### Task 4: Add integration test

**Files:** `gv-server/tests/core_download_test.rs` (new)

```rust
use std::io::Write;

/// `ensure_core` must skip download when the .so already exists.
#[tokio::test]
async fn ensure_core_skips_when_cached() {
    let tmp = tempfile::tempdir().unwrap();
    let core_path = tmp.path().join("fake_core_libretro.so");
    std::fs::write(&core_path, b"fake").unwrap();

    std::env::set_var("GV_CORES_DIR", tmp.path().to_string_lossy().to_string());

    let client = reqwest::Client::new();
    // This should hit the fast path — no network call
    let result = gv_server::worker::ensure_core_for_test("fake_core_libretro.so", &client).await;
    assert!(result.is_ok());
    assert_eq!(result.unwrap(), core_path);
}

/// `ensure_core` must fail gracefully for a nonexistent core
/// (buildbot 404s on unknown cores).
#[tokio::test]
async fn ensure_core_download_fails_for_unknown_core() {
    let tmp = tempfile::tempdir().unwrap();
    std::env::set_var("GV_CORES_DIR", tmp.path().to_string_lossy().to_string());

    let client = reqwest::Client::new();
    let result = gv_server::worker::ensure_core_for_test(
        "nonexistent_core_libretro.so",
        &client,
    )
    .await;
    assert!(result.is_err());
    assert!(
        !tmp.path().join("nonexistent_core_libretro.so").exists(),
        "failed download must not leave a corrupt file"
    );
}
```

Add a public test helper to `worker.rs`:
```rust
/// Test-only entry point for `ensure_core`.
#[doc(hidden)]
pub async fn ensure_core_for_test(
    core_filename: &str,
    client: &reqwest::Client,
) -> Result<PathBuf, String> {
    ensure_core(core_filename, client).await
}
```

Add `tempfile` dev-dependency to `gv-server/Cargo.toml`:
```toml
[dev-dependencies]
tempfile = "3"
```

**Verify:** `cargo test -p gv-server -- --nocapture`

---

### Task 5: Manual smoke test

1. Delete any existing `.so` in the cores dir (except 2048):  
   `rm -f test-data/cores/gambatte_libretro.so`

2. Start gv-server pointing at a paired server with Game Boy ROMs

3. Launch a Game Boy game from the library

4. Observe gv-server logs:
   ```
   [CORE] downloading https://buildbot.libretro.com/nightly/linux/x86_64/latest/gambatte_libretro.so.zip
   [CORE] installed /path/to/test-data/cores/gambatte_libretro.so (4761912 bytes)
   [WORKER] platform=Nintendo - Game Boy → core=gambatte_libretro.so (...)
   ```

5. Relaunch the same game — observe the log shows no download (fast path).

6. Verify the file exists and is executable:  
   `ls -la test-data/cores/gambatte_libretro.so`

**Acceptance:** Core is downloaded once, cached, and reused. Worker loads the real emulator core instead of test pattern.
