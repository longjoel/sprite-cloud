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
}
