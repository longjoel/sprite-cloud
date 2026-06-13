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
    worker_url: String,
    game_id: String,
}

// ── Client ────────────────────────────────────────────────────────────

pub struct GvWebClient {
    client: Client,
    base_url: String,
    auth: Auth,
}

impl GvWebClient {
    pub fn new(base_url: String, auth: Auth) -> Self {
        Self {
            client: Client::new(),
            base_url: base_url.trim_end_matches('/').to_string(),
            auth,
        }
    }

    /// POST /api/auth/pair/claim — exchange pairing code for API key
    pub async fn claim(code: &str, gv_web_url: &str) -> Result<ClaimResponse> {
        let client = Client::new();
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
        const MAX_ATTEMPTS: u32 = 3;
        let mut last_err = None;

        for attempt in 1..=MAX_ATTEMPTS {
            match self
                .notify_once(command_id, worker_url, game_id)
                .await
            {
                Ok(()) => return Ok(()),
                Err(e) => {
                    last_err = Some(e);
                    if attempt < MAX_ATTEMPTS {
                        let delay = std::time::Duration::from_secs(2u64.pow(attempt - 1));
                        tokio::time::sleep(delay).await;
                    }
                }
            }
        }

        Err(last_err.unwrap())
    }

    /// Single notify attempt (no retry).
    async fn notify_once(
        &self,
        command_id: &str,
        worker_url: &str,
        game_id: &str,
    ) -> Result<()> {
        let url = format!("{}/api/server/notify", self.base_url);

        let resp = self
            .client
            .post(&url)
            .bearer_auth(&self.auth.api_key)
            .json(&NotifyBody {
                command_id: command_id.to_string(),
                worker_url: worker_url.to_string(),
                game_id: game_id.to_string(),
            })
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
}
