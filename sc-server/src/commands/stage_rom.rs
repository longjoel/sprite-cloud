//! Staging command — hash + classify a file in the staging area.
//!
//! Invoked by a `stage_rom` command. Reads the file path from the payload,
//! computes the asset manifest, enriches with DAT identity when available,
//! and returns the result.

use crate::rom_transfer::staging;
use crate::sc_web;

pub(crate) async fn handle_stage_rom(
    cmd: &sc_web::Command,
    client: &sc_web::ScWebClient,
    dat_index: Option<&crate::dat::DatIndex>,
) {
    let file_path = match cmd.payload.get("file_path").and_then(|v| v.as_str()) {
        Some(p) => std::path::PathBuf::from(p),
        None => {
            let _ = client
                .command_result(
                    &cmd.id,
                    &cmd.lease_token,
                    &serde_json::json!({"ok": false, "error": "missing file_path"}),
                )
                .await;
            return;
        }
    };

    // Verify the file is within the staging directory
    let staging_root = staging::staging_dir(&[]);
    if !file_path.starts_with(&staging_root) && !staging::staging_dir(&[]).to_string_lossy().is_empty() {
        // Allow files inside ROM roots too (for migration from existing uploads)
        tracing::warn!("[stage] file not in staging dir: {}", file_path.display());
    }

    let metadata = match tokio::fs::metadata(&file_path).await {
        Ok(m) => m,
        Err(e) => {
            let _ = client
                .command_result(
                    &cmd.id,
                    &cmd.lease_token,
                    &serde_json::json!({"ok": false, "error": format!("file not accessible: {e}")}),
                )
                .await;
            return;
        }
    };

    if !metadata.is_file() {
        let _ = client
            .command_result(
                &cmd.id,
                &cmd.lease_token,
                &serde_json::json!({"ok": false, "error": "not a file"}),
            )
            .await;
        return;
    }

    tracing::info!(
        "[stage] computing manifest for {} ({} bytes)",
        file_path.display(),
        metadata.len(),
    );

    let mut manifest = match staging::compute_manifest(&file_path, metadata.len()).await {
        Ok(m) => m,
        Err(e) => {
            tracing::error!("[stage] manifest compute failed: {e}");
            let _ = client
                .command_result(
                    &cmd.id,
                    &cmd.lease_token,
                    &serde_json::json!({"ok": false, "error": format!("hash failed: {e}")}),
                )
                .await;
            return;
        }
    };

    // Enrich with DAT identity when available
    manifest.enrich(dat_index);

    tracing::info!(
        "[stage] manifest ready — sha256={} classification={:?} dat_match={}",
        &manifest.sha256[..12],
        manifest.classification,
        manifest.dat_match.as_ref().map_or("none", |m| &m.canonical_name),
    );

    let _ = client
        .command_result(&cmd.id, &cmd.lease_token, &serde_json::json!(manifest))
        .await;
}
