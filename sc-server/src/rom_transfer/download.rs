//! ROM download — server reads the file and posts it to sc-web over HTTP.
//!
//! Flow: sc-web queues a `rom_download` command → sc-server resolves the
//! game, reads it, HTTP POSTs the bytes to sc-web's upload endpoint
//! (authored with command lease_token), then reports the download URL.

use crate::rom_transfer::storage;
use crate::sc_web;
use sha2::{Digest, Sha256};
use std::sync::Arc;

pub(crate) async fn handle_rom_download(
    cmd: &sc_web::Command,
    client: &sc_web::ScWebClient,
    rom_roots: &[String],
    local_game_list: Arc<tokio::sync::RwLock<Vec<crate::player_server::LocalGame>>>,
) {
    let server_id = cmd.payload.get("server_id").and_then(|v| v.as_str()).unwrap_or("unknown");
    let game_id = match cmd.payload.get("game_id").and_then(|v| v.as_str()) {
        Some(id) => id.to_string(),
        None => {
            let _ = client
                .command_result(&cmd.id, &cmd.lease_token, &serde_json::json!({"ok": false, "error": "missing game_id"}))
                .await;
            return;
        }
    };

    // Resolve the game
    let games = local_game_list.read().await;
    let (path, name, size) = match storage::resolve_download(&game_id, rom_roots, &games) {
        Ok(r) => (r.path.clone(), r.name.clone(), r.size),
        Err(e) => {
            let _ = client.command_result(&cmd.id, &cmd.lease_token, &serde_json::json!({"ok": false, "error": format!("{e:#}")}))
                .await;
            return;
        }
    };
    drop(games);

    tracing::info!("[ROM DL] game_id={game_id} path={} size={size}", path.display());

    // Read the entire file
    let file_bytes = match tokio::fs::read(&path).await {
        Ok(b) => b,
        Err(e) => {
            tracing::error!("[ROM DL] read failed: {e:#}");
            let _ = client.command_result(&cmd.id, &cmd.lease_token, &serde_json::json!({"ok": false, "error": format!("cannot read file: {e}")}))
                .await;
            return;
        }
    };

    let hash = hex::encode(Sha256::digest(&file_bytes));

    // Post file to sc-web
    let upload_url = format!(
        "{}/api/servers/{}/rom-downloads/{}/upload",
        client.base_url(),
        url_encode(server_id),
        url_encode(&game_id),
    );

    let upload_res = match client.http_client()
        .post(&upload_url)
        .header("x-command-id", &cmd.id)
        .header("x-lease-token", &cmd.lease_token)
        .header("x-game-name", &name)
        .header("content-type", "application/octet-stream")
        .body(file_bytes.clone())
        .send()
        .await
    {
        Ok(r) => r,
        Err(e) => {
            tracing::error!("[ROM DL] upload to sc-web failed: {e:#}");
            let _ = client.command_result(&cmd.id, &cmd.lease_token, &serde_json::json!({"ok": false, "error": format!("upload failed: {e}")}))
                .await;
            return;
        }
    };

    if !upload_res.status().is_success() {
        let status = upload_res.status();
        let body = upload_res.text().await.unwrap_or_default();
        tracing::error!("[ROM DL] upload rejected: {status} {body}");
        let _ = client.command_result(&cmd.id, &cmd.lease_token, &serde_json::json!({"ok": false, "error": format!("upload rejected ({status})")}))
            .await;
        return;
    }

    let upload_body: serde_json::Value = match upload_res.json().await {
        Ok(v) => v,
        Err(e) => {
            tracing::error!("[ROM DL] upload response parse: {e:#}");
            let _ = client.command_result(&cmd.id, &cmd.lease_token, &serde_json::json!({"ok": false, "error": "upload response parse failed"}))
                .await;
            return;
        }
    };

    let upload_id = match upload_body.get("upload_id").and_then(|v| v.as_str()) {
        Some(id) => id.to_string(),
        None => {
            let _ = client.command_result(&cmd.id, &cmd.lease_token, &serde_json::json!({"ok": false, "error": "no upload_id"}))
                .await;
            return;
        }
    };

    let download_url = format!("{}/api/download/{}", client.base_url(), url_encode(&upload_id));

    tracing::info!("[ROM DL] ready: {size} bytes, sha256={hash}");

    let _ = client.command_result(&cmd.id, &cmd.lease_token, &serde_json::json!({
        "ok": true,
        "url": download_url,
        "name": name,
        "size": size,
        "sha256": hash,
    }))
    .await;
}

fn url_encode(s: &str) -> String {
    s.chars().map(|c| {
        if c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.' || c == '~' {
            c.to_string()
        } else {
            format!("%{:02X}", c as u8)
        }
    }).collect()
}
