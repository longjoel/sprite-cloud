//! CLI subcommand implementations: `pair` and `start`.

use anyhow::{Context, Result};
use std::collections::HashMap;
use std::time::Duration;

use crate::config;
use crate::dat;
use crate::gv_web;
use crate::scan;
use crate::worker;
use crate::worker::SpawnedWorker;
pub(crate) use version::collect_metadata;
pub(crate) mod version;

// ── pair subcommand ───────────────────────────────────────────────────

pub(crate) async fn cmd_pair(code: &str, gv_web_url: &str) -> Result<()> {
    tracing::info!("Pairing with {} ...", gv_web_url);

    // Collect ROM root paths from env var or existing config.
    // GV_ROM_ROOTS is a comma-separated list of directories.
    let rom_roots: Vec<String> = std::env::var("GV_ROM_ROOTS")
        .ok()
        .map(|s| {
            s.split(',')
                .map(|p| p.trim().to_string())
                .filter(|p| !p.is_empty())
                .collect()
        })
        .unwrap_or_default();

    if !rom_roots.is_empty() {
        tracing::info!("  rom_roots: {:?}", rom_roots);
    }

    let hostname = std::fs::read_to_string("/proc/sys/kernel/hostname")
        .map(|s| s.trim().to_string())
        .unwrap_or_else(|_| "unknown".to_string());

    let resp = gv_web::GvWebClient::claim(code, gv_web_url, rom_roots.clone(), &hostname).await?;

    let cfg = config::Config {
        gv_web: config::GvWeb {
            url: gv_web_url.to_string(),
            // Persist the GV_WORKER_BIN env var if set at pairing time
            worker_bin: std::env::var("GV_WORKER_BIN").ok(),
        },
        auth: config::Auth {
            api_key: resp.api_key.clone(),
            server_id: resp.server_id.clone(),
        },
        rom: if rom_roots.is_empty() {
            None
        } else {
            Some(config::Rom { roots: rom_roots })
        },
    };

    config::save(&cfg).context("save config")?;

    tracing::info!("Paired!");
    tracing::info!("  server_id: {}", resp.server_id);
    tracing::info!(
        "  api_key:   {}",
        &resp.api_key[..8.min(resp.api_key.len())]
    );
    tracing::info!("  config saved");

    Ok(())
}

// ── start subcommand ──────────────────────────────────────────────────

pub(crate) async fn cmd_start(gv_web_url: Option<String>) -> Result<()> {
    let mut cfg = config::load().context("load config (run 'gv-server pair' first)")?;

    if let Some(url) = gv_web_url {
        cfg.gv_web.url = url;
    }

    let client = gv_web::GvWebClient::new(cfg.gv_web.url.clone(), cfg.auth.clone());

    // Extract optional worker_bin override before cfg is consumed
    let worker_bin = cfg.gv_web.worker_bin.clone();

    // Verify the API key is still valid — also report server metadata
    let metadata = collect_metadata(&cfg);
    let verify = match client.verify_with_metadata(&metadata).await {
        Ok(v) => v,
        Err(e) => {
            let msg = format!("{e:#}");
            if msg.contains("401") || msg.contains("unauthorized") {
                tracing::error!(
                    "[AUTH] API key rejected — server must re-pair.\n\
                     The gv-web database may have been recreated, or this server's\n\
                     API key was revoked. Run:\n\n  \
                     gv-server pair <CODE>\n\n\
                     Get a pairing code from the gv-web Settings page.\n\
                     This container will now exit and NOT restart — re-pair first."
                );
                // Exit cleanly (not a crash) so Docker restart policy can be
                // set to on-failure without looping. Exit code 2 = config error.
                std::process::exit(2);
            }
            return Err(e);
        }
    };
    tracing::info!(
        "Connected to gv-web as server {} (user: {})",
        verify.server_id,
        verify.user_id
    );

    // Validate prerequisites before entering the poll loop.
    // Failures here are fatal — don't start with broken prerequisites.
    validate_prerequisites(&cfg, worker_bin.as_deref());

    tracing::info!("gv-server running — polling for commands...");

    // Kill any workers orphaned by a previous crash
    worker::reap_stale_workers();

    const POLL_ERROR_BACKOFF_MS: u64 = 5_000;

    // Track spawned workers so we can kill them on shutdown.
    // Key is the game_id from the start_game command.
    let mut workers: HashMap<String, SpawnedWorker> = HashMap::new();

    // Scan serialization — one concurrent scan per server
    let scan_lock: std::sync::Arc<tokio::sync::Mutex<()>> =
        std::sync::Arc::new(tokio::sync::Mutex::new(()));

    // DAT index — loaded lazily on first scan
    let dat_index: std::sync::Arc<tokio::sync::RwLock<Option<dat::DatIndex>>> =
        std::sync::Arc::new(tokio::sync::RwLock::new(None));

    // ROM roots — configured via GV_ROM_ROOTS env var or config.toml
    let rom_roots: Vec<String> = cfg
        .rom
        .as_ref()
        .map(|r| r.roots.clone())
        .unwrap_or_default();

    loop {
        tokio::select! {
            _ = shutdown_signal() => {
                tracing::info!("[SHUTDOWN] received signal, stopping workers...");
                break;
            }
            _ = async {
                match client.poll().await {
                    Ok(resp) => {
                        if !resp.commands.is_empty() {
                            for cmd in &resp.commands {
                                tracing::info!(
                                    "[POLL] command {}: {} {}",
                                    cmd.id,
                                    cmd.command_type,
                                    cmd.payload,
                                );

                                if cmd.command_type == "start_game" {
                                    let game_id = cmd
                                        .payload
                                        .get("game_id")
                                        .and_then(|v| v.as_str())
                                        .unwrap_or("unknown");
                                    let host_token = cmd
                                        .payload
                                        .get("host_token")
                                        .and_then(|v| v.as_str());
                                    let rom_path = cmd
                                        .payload
                                        .get("rom_path")
                                        .and_then(|v| v.as_str())
                                        .and_then(|rel| {
                                            // Resolve relative path against ROM roots
                                            for root in &rom_roots {
                                                let full = std::path::Path::new(root).join(rel);
                                                if full.exists() {
                                                    return Some(
                                                        full.to_string_lossy().to_string(),
                                                    );
                                                }
                                            }
                                            tracing::warn!(
                                                "[POLL] rom_path not found in any ROM root: {rel}"
                                            );
                                            None
                                        });
                                    let platform = cmd
                                        .payload
                                        .get("platform")
                                        .and_then(|v| v.as_str());
                                    let peer_tokens_json = cmd
                                        .payload
                                        .get("peer_tokens")
                                        .and_then(|v| serde_json::to_string(v).ok());
                                    tracing::info!(
                                        "[POLL] start_game command {} (game: {})",
                                        cmd.id, game_id
                                    );

                                    // Kill previous worker for THIS game_id — a user
                                    // restarting their game should kill the old worker, but
                                    // other users' workers must keep running.
                                    if let Some(old) = workers.remove(game_id) {
                                        tracing::info!(
                                            "[WORKER] killing previous worker for game {game_id}"
                                        );
                                        old.kill().await;
                                    }

                                    // Kill ALL workers owned by this host_token — when a user
                                    // starts a new game, any existing sessions they own are
                                    // terminated. This prevents worker leak on game switch.
                                    if let Some(ht) = host_token {
                                        let mut victim_ids: Vec<String> = Vec::new();
                                        for (gid, w) in workers.iter() {
                                            if w.host_token() == Some(ht) {
                                                victim_ids.push(gid.clone());
                                            }
                                        }
                                        for gid in &victim_ids {
                                            if let Some(old) = workers.remove(gid) {
                                                tracing::info!(
                                                    "[WORKER] killing worker for game {gid} (same host_token, user switched games)"
                                                );
                                                old.kill().await;
                                            }
                                        }
                                    }

                                    match worker::spawn_worker(game_id, worker_bin.as_deref(), host_token, rom_path.as_deref(), platform, peer_tokens_json.as_deref()).await {
                                        Ok(worker) => {
                                            let url = worker.url.clone();
                                            tracing::info!("[WORKER] spawned at {url}");

                                            // Probe health before notifying gv-web
                                            let health_url = format!("{url}/health");
                                            match client
                                                .http_client()
                                                .get(&health_url)
                                                .send()
                                                .await
                                            {
                                                Ok(resp) if resp.status().is_success() => {
                                                    tracing::info!("[WORKER] health check passed for {url}");
                                                }
                                                other => {
                                                    tracing::warn!(
                                                        "[WORKER] health check failed for {url}: {:?}",
                                                        other.err().map(|e| e.to_string())
                                                    );
                                                }
                                            }

                                            // Notify gv-web
                                            if let Err(e) = client
                                                .notify(&cmd.id, &cmd.lease_token, &url, game_id)
                                                .await
                                            {
                                                tracing::error!(
                                                    "[NOTIFY] failed after retries — worker is at {url}\n\
                                                     [NOTIFY]     connect manually or retry from /dev\n\
                                                     [NOTIFY]     error: {e:#}"
                                                );
                                            }

                                            workers.insert(game_id.to_string(), worker);
                                        }
                                        Err(e) => tracing::error!("[WORKER] spawn failed: {e:#}"),
                                    }
                                } else if cmd.command_type == "stop_game" {
                                    let game_id = cmd
                                        .payload
                                        .get("game_id")
                                        .and_then(|v| v.as_str())
                                        .unwrap_or("unknown");
                                    tracing::info!(
                                        "[POLL] stop_game command {} (game: {})",
                                        cmd.id, game_id
                                    );

                                    if let Some(worker) = workers.remove(game_id) {
                                        tracing::info!(
                                            "[WORKER] stopping worker for game {game_id}"
                                        );
                                        worker.kill().await;
                                        if let Err(e) = client
                                            .notify_stop(&cmd.id, &cmd.lease_token, game_id)
                                            .await
                                        {
                                            tracing::error!(
                                                "[NOTIFY] stop notification failed for game {game_id}: {e:#}"
                                            );
                                        }
                                    } else {
                                        tracing::warn!(
                                            "[WORKER] stop_game for unknown game {game_id} — ignoring"
                                        );
                                    }
                                } else if cmd.command_type == "sdp_offer" {
                                    let sdp = cmd
                                        .payload
                                        .get("sdp")
                                        .and_then(|v| v.as_str())
                                        .unwrap_or("");
                                    let game_id = cmd
                                        .payload
                                        .get("game_id")
                                        .and_then(|v| v.as_str())
                                        .unwrap_or("unknown");

                                    if sdp.is_empty() {
                                        tracing::warn!("[SDP] sdp_offer with empty SDP — ignoring");
                                        continue;
                                    }

                                    tracing::info!(
                                        "[SDP] relay offer for game {game_id} ({} chars)",
                                        sdp.len()
                                    );

                                    // Guest SDP offers are now supported — the worker has multi-peer
                                    // infrastructure (singleton core, PeerRegistry, fan-out).

                                    // Reap exited workers before relaying SDP.  A zombie
                                    // child still has a PID, so signal-0 liveness checks are
                                    // insufficient; `reap_if_exited()` uses Child::try_wait().
                                    if workers
                                        .get_mut(game_id)
                                        .map(|worker| worker.reap_if_exited())
                                        .unwrap_or(false)
                                    {
                                        workers.remove(game_id);
                                        if let Err(e) = client
                                            .command_result(
                                                &cmd.id,
                                                &cmd.lease_token,
                                                &serde_json::json!({
                                                    "error": "worker_exited",
                                                    "message": "Worker exited before SDP could be relayed"
                                                }),
                                            )
                                            .await
                                        {
                                            tracing::error!(
                                                "[SDP] command_result failed for exited worker: {e:#}"
                                            );
                                        }
                                        continue;
                                    }

                                    // Find the worker for this game and relay the SDP.
                                    if let Some(worker) = workers.get(game_id) {
                                        let internal_url = worker::internal_worker_url(&worker.url);
                                        tracing::info!(
                                            "[SDP] forwarding to worker at {internal_url}"
                                        );

                                        // Build the SDP body — include tokens so the
                                        // worker can validate the offer authorisation.
                                        let mut sdp_body = serde_json::json!({ "sdp": sdp });
                                        if let Some(ht) = cmd.payload.get("host_token").and_then(|v| v.as_str()) {
                                            sdp_body["host_token"] = serde_json::Value::String(ht.to_string());
                                        }
                                        // Guest peers use peer_token from /api/room/join
                                        if let Some(pt) = cmd.payload.get("peer_token").and_then(|v| v.as_str()) {
                                            sdp_body["peer_token"] = serde_json::Value::String(pt.to_string());
                                        }
                                        // gv-web resolves peer_token → role + seat and enriches the payload
                                        if let Some(pr) = cmd.payload.get("peer_role").and_then(|v| v.as_str()) {
                                            sdp_body["peer_role"] = serde_json::Value::String(pr.to_string());
                                        }
                                        if let Some(ps) = cmd.payload.get("peer_seat") {
                                            sdp_body["peer_seat"] = ps.clone();
                                        }

                                        match client
                                            .http_client()
                                            .post(format!("{internal_url}/sdp"))
                                            .bearer_auth(worker.control_token())
                                            .json(&sdp_body)
                                            .send()
                                            .await
                                        {
                                            Ok(resp) if resp.status().is_success() => {
                                                match resp.json::<serde_json::Value>().await {
                                                    Ok(answer) => {
                                                        if let Some(answer_sdp) =
                                                            answer.get("sdp").and_then(|v| v.as_str())
                                                        {
                                                            tracing::info!(
                                                                "[SDP] got answer from worker ({} chars)",
                                                                answer_sdp.len()
                                                            );
                                                            if let Err(e) = client
                                                                .notify_sdp(
                                                                    &cmd.id,
                                                                    &cmd.lease_token,
                                                                    &worker.url,
                                                                    game_id,
                                                                    answer_sdp,
                                                                )
                                                                .await
                                                            {
                                                                tracing::error!(
                                                                    "[SDP] notify_sdp failed: {e:#}"
                                                                );
                                                            }
                                                        } else {
                                                            tracing::error!(
                                                                "[SDP] worker response missing 'sdp' field"
                                                            );
                                                            if let Err(e) = client
                                                                .command_result(
                                                                    &cmd.id,
                                                                    &cmd.lease_token,
                                                                    &serde_json::json!({
                                                                        "error": "worker_answer_missing_sdp"
                                                                    }),
                                                                )
                                                                .await
                                                            {
                                                                tracing::error!(
                                                                    "[SDP] command_result failed for missing SDP: {e:#}"
                                                                );
                                                            }
                                                        }
                                                    }
                                                    Err(e) => {
                                                        tracing::error!(
                                                            "[SDP] failed to parse worker answer: {e}"
                                                        );
                                                        if let Err(err) = client
                                                            .command_result(
                                                                &cmd.id,
                                                                &cmd.lease_token,
                                                                &serde_json::json!({
                                                                    "error": "worker_answer_parse_failed",
                                                                    "message": e.to_string()
                                                                }),
                                                            )
                                                            .await
                                                        {
                                                            tracing::error!(
                                                                "[SDP] command_result failed for parse error: {err:#}"
                                                            );
                                                        }
                                                    }
                                                }
                                            }
                                            Ok(resp) => {
                                                let status = resp.status();
                                                let status_code = status.as_u16();
                                                let body = resp.text().await.unwrap_or_default();
                                                tracing::error!(
                                                    "[SDP] worker returned HTTP {}: {}",
                                                    status_code,
                                                    body
                                                );
                                                if let Err(e) = client
                                                    .command_result(
                                                        &cmd.id,
                                                        &cmd.lease_token,
                                                        &serde_json::json!({
                                                            "error": "worker_sdp_http_error",
                                                            "status": status_code,
                                                            "message": body
                                                        }),
                                                    )
                                                    .await
                                                {
                                                    tracing::error!(
                                                        "[SDP] command_result failed for HTTP error: {e:#}"
                                                    );
                                                }
                                            }
                                            Err(e) => {
                                                tracing::error!(
                                                    "[SDP] failed to reach worker at {internal_url}: {e}"
                                                );
                                                if let Err(err) = client
                                                    .command_result(
                                                        &cmd.id,
                                                        &cmd.lease_token,
                                                        &serde_json::json!({
                                                            "error": "worker_unreachable",
                                                            "message": e.to_string()
                                                        }),
                                                    )
                                                    .await
                                                {
                                                    tracing::error!(
                                                        "[SDP] command_result failed for unreachable worker: {err:#}"
                                                    );
                                                }
                                            }
                                        }
                                    } else {
                                        tracing::warn!(
                                            "[SDP] no worker running for game {game_id} — completing sdp_offer with error"
                                        );
                                        if let Err(e) = client
                                            .command_result(
                                                &cmd.id,
                                                &cmd.lease_token,
                                                &serde_json::json!({
                                                    "error": "worker_not_running",
                                                    "message": "No worker is running for this game"
                                                }),
                                            )
                                            .await
                                        {
                                            tracing::error!(
                                                "[SDP] command_result failed for no-worker: {e:#}"
                                            );
                                        }
                                    }
                                } else if cmd.command_type == "browse_files" {
                                    let path = cmd
                                        .payload
                                        .get("path")
                                        .and_then(|v| v.as_str())
                                        .unwrap_or("");

                                    let tree = match scan::resolve_within_roots(
                                        std::path::Path::new(path),
                                        &rom_roots,
                                    ) {
                                        Ok(resolved) => scan::browse_path(&resolved),
                                        Err(e) => {
                                            tracing::warn!("[BROWSE] path rejected: {e:#}");
                                            scan::TreeNode {
                                                name: format!("Error: {e}"),
                                                node_type: "error".into(),
                                                children: vec![],
                                            }
                                        }
                                    };

                                    let result = serde_json::json!({ "tree": tree });
                                    if let Err(e) = client
                                        .command_result(&cmd.id, &cmd.lease_token, &result)
                                        .await
                                    {
                                        tracing::error!(
                                            "[BROWSE] failed to report result: {e:#}"
                                        );
                                    }
                                } else if cmd.command_type == "scan_paths" {
                                    let paths: Vec<String> = cmd
                                        .payload
                                        .get("paths")
                                        .and_then(|v| v.as_array())
                                        .map(|arr| {
                                            arr.iter()
                                                .filter_map(|v| {
                                                    v.as_str().map(String::from)
                                                })
                                                .collect()
                                        })
                                        .unwrap_or_default();

                                    // DoS guard — one scan at a time
                                    if scan_lock.try_lock().is_err() {
                                        tracing::warn!(
                                            "[SCAN] rejected — scan already in progress"
                                        );
                                        let result = serde_json::json!({
                                            "error": "A scan is already in progress."
                                        });
                                        let _ = client
                                            .command_result(&cmd.id, &cmd.lease_token, &result)
                                            .await;
                                        continue;
                                    }

                                    // Lock held until this block exits (dropped
                                    // after result is reported).
                                    let _guard = scan_lock.lock().await;

                                    let mut all_files = Vec::new();
                                    for p in &paths {
                                        let resolved = match scan::resolve_within_roots(
                                            std::path::Path::new(p),
                                            &rom_roots,
                                        ) {
                                            Ok(r) => r,
                                            Err(e) => {
                                                tracing::warn!(
                                                    "[SCAN] path rejected: {e:#}"
                                                );
                                                continue;
                                            }
                                        };

                                        let mut files =
                                            scan::discover_roms(&resolved)
                                                .unwrap_or_default();
                                        scan::hash_files(&mut files, &resolved);
                                        all_files.extend(files);
                                    }

                                    // Match against DAT index (loaded lazily per extension)
                                    let mut dat_lock = dat_index.write().await;
                                    if dat_lock.is_none() {
                                        let mut combined: Option<crate::dat::DatIndex> = None;
                                        let mut seen_exts = std::collections::HashSet::new();
                                        for file in &all_files {
                                            if let Some(ext) = file
                                                .relative_path
                                                .rsplit('.')
                                                .next()
                                            {
                                                let ext_lower = ext.to_lowercase();
                                                if seen_exts.contains(&ext_lower) {
                                                    continue;
                                                }
                                                seen_exts.insert(ext_lower.clone());
                                                if let Some(index) = crate::dat::load_for_extension(
                                                    &ext_lower,
                                                    &dirs::cache_dir()
                                                        .unwrap_or_default()
                                                        .join("games-vault")
                                                        .join("dat"),
                                                )
                                                .await
                                                {
                                                    match &mut combined {
                                                        Some(c) => c.merge(index),
                                                        None => combined = Some(index),
                                                    }
                                                }
                                            }
                                        }
                                        *dat_lock = combined;
                                    }

                                    let mut matches = Vec::new();
                                    for file in &all_files {
                                        let dat_match = if let (
                                            Some(crc),
                                            Some(sha),
                                        ) = (&file.crc, &file.sha256)
                                        {
                                            dat_lock
                                                .as_ref()
                                                .and_then(|idx| {
                                                    crate::dat::match_entry(
                                                        idx, crc, sha,
                                                    )
                                                })
                                                .map(|e| {
                                                    serde_json::json!({
                                                        "name": e.canonical_name,
                                                        "game_name": e.game_name,
                                                    })
                                                })
                                        } else {
                                            None
                                        };

                                        matches.push(serde_json::json!({
                                            "file": file,
                                            "match": dat_match,
                                        }));
                                    }

                                    drop(dat_lock);

                                    let result =
                                        serde_json::json!({ "matches": matches });
                                    if let Err(e) = client
                                        .command_result(&cmd.id, &cmd.lease_token, &result)
                                        .await
                                    {
                                        tracing::error!(
                                            "[SCAN] failed to report result: {e:#}"
                                        );
                                    }
                                }
                            }
                        }

                        // ── Dead worker cleanup ──────────────────────────────
                        // Check if any spawned workers have died unexpectedly
                        // (crash, OOM, SIGKILL from outside).  If so, remove
                        // from the map and tell gv-web to end the session.
                        let mut dead: Vec<String> = Vec::new();
                        for (game_id, worker) in workers.iter_mut() {
                            if worker.reap_if_exited() {
                                tracing::warn!(
                                    "[WORKER] worker for game {game_id} died — notifying gv-web"
                                );
                                dead.push(game_id.clone());
                            }
                        }
                        for game_id in &dead {
                            workers.remove(game_id);
                            // Best-effort — if gv-web is unreachable, the session
                            // will be cleaned up on next gv-server startup by
                            // reap_stale_workers + the upsert invariant.
                            if let Err(e) = client.notify_worker_dead(game_id).await {
                                tracing::error!(
                                    "[WORKER] failed to notify death for {game_id}: {e:#}"
                                );
                            }
                        }

                        tokio::time::sleep(Duration::from_millis(resp.next_poll_ms)).await;
                    }
                    Err(e) => {
                        tracing::error!("[POLL] error: {:#}", e);
                        tracing::warn!(
                            "[POLL] backing off {}s before retry...",
                            POLL_ERROR_BACKOFF_MS / 1000
                        );
                        tokio::time::sleep(Duration::from_millis(POLL_ERROR_BACKOFF_MS)).await;
                    }
                }
            } => {}
        }
    }

    // Drain workers — kill each one and wait for it to exit
    for (game_id, worker) in workers {
        tracing::info!("[SHUTDOWN] stopping worker for game {game_id}");
        worker.kill().await;
    }

    tracing::info!("[SHUTDOWN] done");
    Ok(())
}
/// Validate that the server's prerequisites are met before entering
/// the poll loop.  Failures here are fatal — the server exits with
/// a clear error message instead of starting in a broken state.
fn validate_prerequisites(cfg: &config::Config, worker_bin: Option<&str>) {
    let mut ok = true;

    // 1. ROM roots exist, are directories, and are readable.
    if let Some(rom) = &cfg.rom {
        for root in &rom.roots {
            match std::fs::metadata(root) {
                Err(e) => {
                    tracing::error!(
                        "ROM root not found: {root} ({e})"
                    );
                    ok = false;
                }
                Ok(meta) if !meta.is_dir() => {
                    tracing::error!(
                        "ROM root is not a directory: {root}"
                    );
                    ok = false;
                }
                Ok(_) => {
                    tracing::info!("ROM root ok: {root}");
                }
            }
        }
    } else {
        tracing::warn!("No ROM roots configured — library will be empty");
    }

    // 2. Worker binary exists and is executable.
    let resolved = worker::resolve_worker_bin(worker_bin);
    match std::fs::metadata(&resolved) {
        Err(e) => {
            tracing::error!(
                "Worker binary not found: {resolved} ({e})"
            );
            tracing::error!(
                "Build: cargo build --release -p gv-server"
            );
            ok = false;
        }
        Ok(meta) => {
            // On Unix, check the executable bit.
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                if meta.permissions().mode() & 0o111 == 0 {
                    tracing::error!(
                        "Worker binary is not executable: {resolved}"
                    );
                    ok = false;
                }
            }
            if ok {
                tracing::info!("Worker binary ok: {resolved}");
            }
        }
    }

    if !ok {
        tracing::error!("Prerequisite validation failed — exiting.");
        std::process::exit(1);
    }
}

// ── Shutdown signal ───────────────────────────────────────────────────

/// Returns when the process receives SIGINT (Ctrl+C) or SIGTERM.
#[cfg(unix)]
async fn shutdown_signal() {
    use tokio::signal::unix::{SignalKind, signal};

    let mut sigint = signal(SignalKind::interrupt()).expect("register SIGINT handler");
    let mut sigterm = signal(SignalKind::terminate()).expect("register SIGTERM handler");

    tokio::select! {
        _ = sigint.recv() => {},
        _ = sigterm.recv() => {},
    }
}

#[cfg(not(unix))]
async fn shutdown_signal() {
    tokio::signal::ctrl_c()
        .await
        .expect("register Ctrl+C handler");
}