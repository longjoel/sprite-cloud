use anyhow::{Context, Result};
use reqwest::Client;
use serde::{Deserialize, Serialize};

use crate::config::Auth;

// ── API types ─────────────────────────────────────────────────────────

#[derive(Debug, Serialize)]
struct ClaimRequest {
    code: String,
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
}

/// A single command from the queue.
#[derive(Debug, Deserialize)]
pub struct Command {
    pub id: String,
    #[serde(rename = "type")]
    pub command_type: String,
    pub payload: serde_json::Value,
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
}

// ── Client ────────────────────────────────────────────────────────────

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

    /// POST /api/auth/pair/claim — exchange pairing code for API key
    pub async fn claim(code: &str, gv_web_url: &str) -> Result<ClaimResponse> {
        let client = reqwest::Client::builder()
            .timeout(crate::config::http_timeout())
            .build()
            .expect("create HTTP client");
        let url = format!("{}/api/auth/pair/claim", gv_web_url.trim_end_matches('/'));

        let resp = client
            .post(&url)
            .json(&ClaimRequest {
                code: code.to_string(),
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
    pub async fn verify(&self) -> Result<VerifyResponse> {
        let url = format!("{}/api/auth/verify", self.base_url);

        let resp = self
            .client
            .get(&url)
            .bearer_auth(&self.auth.api_key)
            .send()
            .await
            .context("GET /api/auth/verify — network error")?;

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
    /// Called after `start_game` spawns a gv-worker so gv-web can
    /// surface the connect URL to the browser.
    ///
    /// Retries up to 3 times with exponential backoff for transient
    /// network failures.
    pub async fn notify(&self, command_id: &str, worker_url: &str, game_id: &str) -> Result<()> {
        crate::retry::with_retry(
            3,
            std::time::Duration::from_secs(1),
            || self.notify_once(command_id, worker_url, game_id, None),
        )
        .await
    }

    /// POST /api/server/notify with an SDP answer.
    ///
    /// Called after relaying an SDP offer to a gv-worker so the browser
    /// can retrieve the answer via polling.
    pub async fn notify_sdp(
        &self,
        command_id: &str,
        worker_url: &str,
        game_id: &str,
        sdp_answer: &str,
    ) -> Result<()> {
        crate::retry::with_retry(
            3,
            std::time::Duration::from_secs(1),
            || {
                self.notify_once(
                    command_id,
                    worker_url,
                    game_id,
                    Some(sdp_answer.to_string()),
                )
            },
        )
        .await
    }

    /// Single notify attempt (no retry).
    async fn notify_once(
        &self,
        command_id: &str,
        worker_url: &str,
        game_id: &str,
        sdp_answer: Option<String>,
    ) -> Result<()> {
        let url = format!("{}/api/server/notify", self.base_url);

        let body = NotifyBody {
            command_id: command_id.to_string(),
            worker_url: worker_url.to_string(),
            game_id: game_id.to_string(),
            sdp_answer,
            action: None,
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
    pub async fn notify_stop(&self, command_id: &str, game_id: &str) -> Result<()> {
        crate::retry::with_retry(
            3,
            std::time::Duration::from_secs(1),
            || self.notify_stop_once(command_id, game_id),
        )
        .await
    }

    async fn notify_stop_once(&self, command_id: &str, game_id: &str) -> Result<()> {
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
}
