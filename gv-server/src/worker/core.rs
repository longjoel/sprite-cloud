use std::path::PathBuf;

/// Resolve the full path to a core file.
///
/// Looks in `GV_CORES_DIR` (defaults to `./test-data/cores/` relative to
/// the worker binary, or `./cores/` as fallback).
fn resolve_core_path(core_filename: &str) -> PathBuf {
    let cores_dir = std::env::var("GV_CORES_DIR").unwrap_or_else(|_| {
        // Default: cores at workspace/test-data/cores/
        // CARGO_MANIFEST_DIR = <workspace>/gv-server → pop to workspace root
        let mut p = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        p.pop(); // → <workspace>
        p.push("test-data/cores");
        if p.exists() {
            return p.to_string_lossy().to_string();
        }
        // Fallback: <workspace>/cores/
        p.pop();
        p.pop();
        p.push("cores");
        p.to_string_lossy().to_string()
    });
    PathBuf::from(&cores_dir).join(core_filename)
}

// ── Automatic core download ───────────────────────────────────────────

/// Base URL for libretro buildbot nightly core downloads.
/// Override via `GV_BUILDBOT_URL` env var (e.g. for mirrors or stable channel).
static BUILDBOT_BASE: std::sync::LazyLock<String> = std::sync::LazyLock::new(|| {
    std::env::var("GV_BUILDBOT_URL")
        .unwrap_or_else(|_| "https://buildbot.libretro.com/nightly/linux/x86_64/latest".into())
});

/// Set of core filenames currently being downloaded.
/// Prevents concurrent duplicate downloads of the same core.
static DOWNLOADING: std::sync::LazyLock<std::sync::Mutex<std::collections::HashSet<String>>> =
    std::sync::LazyLock::new(|| std::sync::Mutex::new(std::collections::HashSet::new()));

/// Ensure a core `.so` file exists in the cores directory.
///
/// If the file is already present, returns its path immediately.
/// Otherwise downloads it from the buildbot, extracts it, and
/// returns the path.  Concurrent calls for the same core wait
/// for the first download to finish.
pub(super) async fn ensure_core(core_filename: &str, client: &reqwest::Client) -> Result<PathBuf, String> {
    let core_path = resolve_core_path(core_filename);

    // Fast path: already cached
    if core_path.exists() {
        return Ok(core_path);
    }

    // Serialize downloads of the same core
    let already_downloading = {
        let mut inflight = DOWNLOADING
            .lock()
            .map_err(|e| format!("lock poisoned: {e}"))?;
        if inflight.contains(core_filename) {
            true
        } else {
            inflight.insert(core_filename.to_string());
            false
        }
    };

    if already_downloading {
        // Another task is downloading — poll until the file appears
        for _ in 0..60 {
            tokio::time::sleep(std::time::Duration::from_secs(1)).await;
            if core_path.exists() {
                return Ok(core_path);
            }
        }
        return Err("timed out waiting for concurrent core download".into());
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

    let bytes = resp.bytes().await.map_err(|e| format!("read body: {e}"))?;

    // Extract the single .so file
    let cursor = std::io::Cursor::new(bytes.as_ref());
    let mut archive = zip::ZipArchive::new(cursor).map_err(|e| format!("open zip: {e}"))?;

    if archive.len() != 1 {
        return Err(format!(
            "expected 1 file in {zip_name}, got {}",
            archive.len()
        ));
    }

    let mut entry = archive
        .by_index(0)
        .map_err(|e| format!("read zip entry: {e}"))?;
    let name = entry.name().to_string();

    if !name.ends_with(".so") || name.contains('/') {
        return Err(format!(
            "unexpected file in {zip_name}: {name} (expected {core_filename})"
        ));
    }

    // Ensure parent directory exists
    if let Some(parent) = core_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("create cores dir: {e}"))?;
    }

    // Write to a temp file first, then rename atomically
    let tmp_path = core_path.with_extension("tmp");
    let mut out =
        std::fs::File::create(&tmp_path).map_err(|e| format!("create {tmp_path:?}: {e}"))?;
    std::io::copy(&mut entry, &mut out).map_err(|e| format!("extract {name}: {e}"))?;
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

    let size = std::fs::metadata(core_path).map(|m| m.len()).unwrap_or(0);
    tracing::info!("[CORE] installed {} ({} bytes)", core_path.display(), size);

    Ok(())
}

/// Test-only entry point for `ensure_core`.
#[doc(hidden)]
#[allow(dead_code)]
pub async fn ensure_core_for_test(
    core_filename: &str,
    client: &reqwest::Client,
) -> Result<PathBuf, String> {
    ensure_core(core_filename, client).await
}
