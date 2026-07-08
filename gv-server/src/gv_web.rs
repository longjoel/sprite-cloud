use anyhow::{Context, Result};
use reqwest::Client;
use serde::{Deserialize, Serialize};

use crate::config::Auth;

// ── API types ─────────────────────────────────────────────────────────

#[derive(Debug, Serialize)]
struct ClaimRequest {
    code: String,
    server_name: String,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    rom_roots: Vec<String>,
}

#[derive(Debug, Deserialize)]
pub struct ClaimResponse {
    pub server_id: String,
    pub api_key: String,
}

#[derive(Debug, Deserialize)]
pub struct VerifyResponse {
    pub server_id: String,
    pub user_id: String,
    #[allow(dead_code)]
    pub name: String,
    #[serde(default)]
    pub core_overrides: std::collections::HashMap<String, String>,
}

/// Release/build metadata for a deployed component.
#[derive(Debug, Serialize)]
pub struct ComponentVersion {
    pub package_version: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub git_sha: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub artifact_sha256: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub built_at_utc: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub released_at_utc: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub binary_path: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct VersionMetadata {
    pub server: ComponentVersion,
    pub worker: ComponentVersion,
    pub runner: ComponentVersion,
}

/// A network interface on the server host.
#[derive(Debug, Serialize)]
pub struct InterfaceInfo {
    pub name: String,
    pub address: String,
}

/// Non-secret metadata reported by gv-server during verify.
/// Excludes credentials, tokens, and other secrets.
#[derive(Debug, Serialize)]
pub struct ServerMetadata {
    pub version: String,
    pub versions: VersionMetadata,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub interfaces: Vec<InterfaceInfo>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub public_ip: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub rom_roots: Vec<String>,
    pub ice: IceMetadata,
    pub runtime: RuntimeMetadata,
    pub lan: LanMetadata,
}

/// Non-secret LAN discovery data reported by gv-server.
#[derive(Debug, Serialize)]
pub struct LanMetadata {
    pub player_port: u16,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub player_urls: Vec<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub health_urls: Vec<String>,
}

/// ICE configuration summary for route/connectivity diagnostics.
/// No credentials — URLs-only plus redacted presence/state fields.
#[derive(Debug, Serialize)]
pub struct IceMetadata {
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub stun_urls: Vec<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub turn_urls: Vec<String>,
    pub stun_url_count: usize,
    pub turn_url_count: usize,
    pub turn_configured: bool,
    pub turn_username_present: bool,
    pub turn_credential_present: bool,
    pub transport_policy: String,
    pub status: String,
    pub defaulted_to_public_stun: bool,
}

/// Runtime configuration exposed for dashboard display.
#[derive(Debug, Serialize)]
pub struct RuntimeMetadata {
    pub pc_pool_size: usize,
    pub video_scale_height: u32,
    pub video_max_scale: u32,
}

/// A single command from the queue.
#[derive(Debug, Clone, Deserialize)]
pub struct Command {
    pub id: String,
    #[serde(rename = "type")]
    pub command_type: String,
    pub payload: serde_json::Value,
    pub lease_token: String,
    /// Part of the API contract; parsed from JSON but not read server-side.
    #[allow(dead_code)]
    pub lease_expires_at: String,
    #[allow(dead_code)]
    pub attempt: u32,
}

/// Response from GET /api/server/poll.
#[derive(Debug, Deserialize)]
pub struct PollResponse {
    pub commands: Vec<Command>,
    pub next_poll_ms: u64,
}

/// Body for POST /api/server/notify.
#[derive(Debug, Serialize)]
struct NotifyBody {
    command_id: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    worker_url: String,
    game_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    sdp_answer: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    action: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    lease_token: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    session_id: Option<String>,
}

// ── Client ────────────────────────────────────────────────────────────

#[derive(Clone)]
pub struct GvWebClient {
    client: Client,
    base_url: String,
    auth: Auth,
}

impl GvWebClient {
    pub fn new(base_url: String, auth: Auth) -> Self {
        let client = reqwest::Client::builder()
            .timeout(crate::config::http_timeout())
            .build()
            .expect("create HTTP client");
        Self {
            client,
            base_url: base_url.trim_end_matches('/').to_string(),
            auth,
        }
    }

    /// Return a reference to the underlying reqwest client.
    /// Useful for health checks and other non-gv-web HTTP calls.
    pub fn http_client(&self) -> &Client {
        &self.client
    }

    /// POST /api/auth/pair/claim — exchange pairing code for API key.
    /// Optionally reports the server's ROM root paths to gv-web.
    pub async fn claim(
        code: &str,
        gv_web_url: &str,
        rom_roots: Vec<String>,
        hostname: &str,
    ) -> Result<ClaimResponse> {
        let client = reqwest::Client::builder()
            .timeout(crate::config::http_timeout())
            .build()
            .expect("create HTTP client");
        let url = format!("{}/api/auth/pair/claim", gv_web_url.trim_end_matches('/'));

        let resp = client
            .post(&url)
            .json(&ClaimRequest {
                code: code.to_string(),
                server_name: hostname.to_string(),
                rom_roots,
            })
            .send()
            .await
            .context("POST /api/auth/pair/claim — network error")?;

        let status = resp.status();
        if !status.is_success() {
            let body = resp.text().await.unwrap_or_default();
            anyhow::bail!("claim failed (HTTP {}): {}", status.as_u16(), body);
        }

        resp.json::<ClaimResponse>()
            .await
            .context("parse claim response")
    }

    /// GET /api/auth/verify — verify API key is still valid
    #[allow(dead_code)]
    pub async fn verify(&self) -> Result<VerifyResponse> {
        self.verify_inner(None).await
    }

    /// POST /api/auth/verify — verify API key and report server metadata.
    ///
    /// Metadata includes version, LAN addresses, ROM roots, and ICE config
    /// summary (no credentials).  Stored by gv-web for connectivity diagnostics.
    pub async fn verify_with_metadata(&self, metadata: &ServerMetadata) -> Result<VerifyResponse> {
        self.verify_inner(Some(metadata)).await
    }

    async fn verify_inner(&self, metadata: Option<&ServerMetadata>) -> Result<VerifyResponse> {
        let url = format!("{}/api/auth/verify", self.base_url);

        let req = self.client.get(&url).bearer_auth(&self.auth.api_key);

        let resp = if let Some(meta) = metadata {
            // Use POST when sending metadata
            self.client
                .post(&url)
                .bearer_auth(&self.auth.api_key)
                .json(&serde_json::json!({ "metadata": meta }))
                .send()
                .await
                .context("POST /api/auth/verify — network error")?
        } else {
            req.send()
                .await
                .context("GET /api/auth/verify — network error")?
        };

        let status = resp.status();
        if !status.is_success() {
            let body = resp.text().await.unwrap_or_default();
            anyhow::bail!("verify failed (HTTP {}): {}", status.as_u16(), body);
        }

        resp.json::<VerifyResponse>()
            .await
            .context("parse verify response")
    }

    /// GET /api/server/poll — fetch pending commands.
    ///
    /// Returns a list of commands and the recommended next-poll interval
    /// in milliseconds.  The server uses `next_poll_ms` verbatim — no
    /// hardcoded polling intervals on the client side.
    pub async fn poll(&self) -> Result<PollResponse> {
        let url = format!("{}/api/server/poll", self.base_url);

        let resp = self
            .client
            .get(&url)
            .bearer_auth(&self.auth.api_key)
            .send()
            .await
            .context("GET /api/server/poll — network error")?;

        let status = resp.status();
        if !status.is_success() {
            let body = resp.text().await.unwrap_or_default();
            anyhow::bail!("poll failed (HTTP {}): {}", status.as_u16(), body);
        }

        resp.json::<PollResponse>()
            .await
            .context("parse poll response")
    }

    /// POST /api/server/notify — report worker URL after spawning.
    ///
    /// Called after `start_game` starts a host-runtime session so gv-web can
    /// surface the connect URL to the browser.
    ///
    /// Retries up to 3 times with exponential backoff for transient
    /// network failures.
    pub async fn notify(
        &self,
        command_id: &str,
        lease_token: &str,
        worker_url: &str,
        game_id: &str,
        session_id: Option<&str>,
    ) -> Result<()> {
        crate::retry::with_retry(3, std::time::Duration::from_secs(1), || {
            self.notify_once(
                command_id,
                lease_token,
                worker_url,
                game_id,
                None,
                session_id,
            )
        })
        .await
    }

    /// POST /api/server/notify with an SDP answer.
    ///
    /// Called after relaying an SDP offer to the host runtime so the browser
    /// can retrieve the answer via polling.
    pub async fn notify_sdp(
        &self,
        command_id: &str,
        lease_token: &str,
        worker_url: &str,
        game_id: &str,
        sdp_answer: &str,
        session_id: Option<&str>,
    ) -> Result<()> {
        crate::retry::with_retry(3, std::time::Duration::from_secs(1), || {
            self.notify_once(
                command_id,
                lease_token,
                worker_url,
                game_id,
                Some(sdp_answer.to_string()),
                session_id,
            )
        })
        .await
    }

    /// Single notify attempt (no retry). Public so the main command loop
    /// can notify without an SDP answer for viewer-join placeholder commands.
    pub async fn notify_once(
        &self,
        command_id: &str,
        lease_token: &str,
        worker_url: &str,
        game_id: &str,
        sdp_answer: Option<String>,
        session_id: Option<&str>,
    ) -> Result<()> {
        let url = format!("{}/api/server/notify", self.base_url);

        let body = NotifyBody {
            command_id: command_id.to_string(),
            worker_url: worker_url.to_string(),
            game_id: game_id.to_string(),
            sdp_answer,
            action: None,
            lease_token: Some(lease_token.to_string()),
            session_id: session_id.map(|s| s.to_string()),
        };

        let resp = self
            .client
            .post(&url)
            .bearer_auth(&self.auth.api_key)
            .json(&body)
            .send()
            .await
            .context("POST /api/server/notify — network error")?;

        let status = resp.status();
        if !status.is_success() {
            let body = resp.text().await.unwrap_or_default();
            anyhow::bail!("notify failed (HTTP {}): {}", status.as_u16(), body);
        }

        Ok(())
    }

    /// POST /api/server/notify with action: "stop".
    ///
    /// Tells gv-web to mark the session as ended so the browser stops
    /// polling for a worker URL.
    pub async fn notify_stop(
        &self,
        command_id: &str,
        lease_token: &str,
        game_id: &str,
        session_id: Option<&str>,
    ) -> Result<()> {
        crate::retry::with_retry(3, std::time::Duration::from_secs(1), || {
            self.notify_stop_once(command_id, lease_token, game_id, session_id)
        })
        .await
    }

    /// Notify gv-web that a worker died unexpectedly (crash, OOM, etc.).
    /// Sends a stop action with an empty command_id — the notify endpoint
    /// handles stop actions without command validation.
    pub async fn notify_worker_dead(&self, game_id: &str, session_id: Option<&str>) -> Result<()> {
        let url = format!("{}/api/server/notify", self.base_url);

        let resp = self
            .client
            .post(&url)
            .bearer_auth(&self.auth.api_key)
            .json(&NotifyBody {
                command_id: "__worker_dead__".to_string(),
                worker_url: String::new(),
                game_id: game_id.to_string(),
                sdp_answer: None,
                action: Some("stop".to_string()),
                lease_token: None,
                session_id: session_id.map(|s| s.to_string()),
            })
            .send()
            .await
            .context("POST /api/server/notify (worker_dead) — network error")?;

        let status = resp.status();
        if !status.is_success() {
            let body = resp.text().await.unwrap_or_default();
            anyhow::bail!(
                "notify worker dead failed (HTTP {}): {}",
                status.as_u16(),
                body
            );
        }

        Ok(())
    }

    async fn notify_stop_once(
        &self,
        command_id: &str,
        lease_token: &str,
        game_id: &str,
        session_id: Option<&str>,
    ) -> Result<()> {
        let url = format!("{}/api/server/notify", self.base_url);

        let resp = self
            .client
            .post(&url)
            .bearer_auth(&self.auth.api_key)
            .json(&NotifyBody {
                command_id: command_id.to_string(),
                worker_url: String::new(),
                game_id: game_id.to_string(),
                sdp_answer: None,
                action: Some("stop".to_string()),
                lease_token: Some(lease_token.to_string()),
                session_id: session_id.map(|s| s.to_string()),
            })
            .send()
            .await
            .context("POST /api/server/notify (stop) — network error")?;

        let status = resp.status();
        if !status.is_success() {
            let body = resp.text().await.unwrap_or_default();
            anyhow::bail!("notify stop failed (HTTP {}): {}", status.as_u16(), body);
        }

        Ok(())
    }

    /// POST /api/server/result — report the result of a completed command.
    ///
    /// Used by browse_files and scan_paths to report file trees and
    /// match results back to gv-web for browser polling.
    pub async fn command_result(
        &self,
        command_id: &str,
        lease_token: &str,
        result: &serde_json::Value,
    ) -> Result<()> {
        let url = format!("{}/api/server/result", self.base_url);

        let resp = self
            .client
            .post(&url)
            .bearer_auth(&self.auth.api_key)
            .json(&serde_json::json!({
                "command_id": command_id,
                "lease_token": lease_token,
                "result": result,
            }))
            .send()
            .await
            .context("POST /api/server/result — network error")?;

        let status = resp.status();
        if !status.is_success() {
            let body = resp.text().await.unwrap_or_default();
            anyhow::bail!("command_result failed (HTTP {}): {}", status.as_u16(), body);
        }

        Ok(())
    }

    /// POST /api/server/import — auto-import scanned game files into library.
    pub async fn import_library(
        &self,
        server_id: &str,
        files: &[serde_json::Value],
    ) -> anyhow::Result<()> {
        let url = format!("{}/api/server/import", self.base_url);
        let resp = self
            .client
            .post(&url)
            .bearer_auth(&self.auth.api_key)
            .json(&serde_json::json!({ "server_id": server_id, "files": files }))
            .send()
            .await
            .context("POST /api/server/import")?;

        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            anyhow::bail!("import failed: HTTP {status} — {body}");
        }
        Ok(())
    }
}
