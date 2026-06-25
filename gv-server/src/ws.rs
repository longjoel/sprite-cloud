//! WebSocket client to gv-web.
//!
//! Replaces the HTTP polling loop. gv-server opens one persistent
//! WebSocket to gv-web on startup; commands arrive as JSON messages
//! instead of being polled from the database every 500ms.

use anyhow::{Context, Result};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use tokio::net::TcpStream;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream, connect_async};
use tokio_tungstenite::tungstenite::Message;
use url::Url;

// ── Wire protocol ───────────────────────────────────────────────────

/// Message from gv-web → gv-server
#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ServerCommand {
    StartGame {
        command_id: String,
        lease_token: String,
        game_id: String,
        session_id: String,
        host_token: Option<String>,
        platform: Option<String>,
        rom_path: Option<String>,
        peer_tokens: Option<Vec<PeerToken>>,
    },
    SdpOffer {
        command_id: String,
        lease_token: String,
        game_id: String,
        session_id: String,
        sdp: String,
    },
    StopGame {
        command_id: String,
        lease_token: String,
        game_id: String,
        session_id: Option<String>,
    },
    Input {
        game_id: String,
        session_id: Option<String>,
        port: u32,
        state: u16,
    },
    BrowseFiles {
        command_id: String,
        lease_token: String,
        path: String,
    },
    ScanPaths {
        command_id: String,
        lease_token: String,
        paths: Vec<String>,
    },
}

#[derive(Debug, Deserialize)]
pub struct PeerToken {
    pub role: String,
    pub seat: u32,
    pub token: String,
}

/// Message from gv-server → gv-web
#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ServerResponse {
    GameReady {
        command_id: String,
        lease_token: String,
        game_id: String,
        session_id: String,
        worker_url: String,
    },
    SdpAnswer {
        command_id: String,
        lease_token: String,
        game_id: String,
        session_id: String,
        worker_url: String,
        sdp_answer: String,
    },
    GameError {
        command_id: String,
        lease_token: String,
        game_id: String,
        session_id: String,
        error: String,
    },
    GameEnded {
        game_id: String,
        session_id: Option<String>,
    },
    ScanResult {
        command_id: String,
        lease_token: String,
        result: serde_json::Value,
    },
    BrowseResult {
        command_id: String,
        lease_token: String,
        result: serde_json::Value,
    },
}

/// Authenticated WebSocket connection to gv-web.
pub struct WsClient {
    ws: WebSocketStream<MaybeTlsStream<TcpStream>>,
}

impl WsClient {
    /// Connect to gv-web's WebSocket endpoint and authenticate.
    pub async fn connect(gv_web_url: &str, server_id: &str, api_key: &str) -> Result<Self> {
        // Build WS URL from HTTP URL
        let http_url: Url = gv_web_url.parse()
            .with_context(|| format!("invalid gv_web URL: {gv_web_url}"))?;
        let ws_scheme = if http_url.scheme() == "https" { "wss" } else { "ws" };
        let ws_url_str = format!(
            "{}://{}:{}/api/server/ws",
            ws_scheme,
            http_url.host_str().context("no host in gv_web URL")?,
            http_url.port().unwrap_or(if ws_scheme == "wss" { 443 } else { 80 })
        );
        let ws_url: Url = ws_url_str.parse()?;

        tracing::info!("[WS] connecting to {ws_url}");

        let (ws, _resp) = connect_async(ws_url)
            .await
            .with_context(|| "WebSocket connection failed")?;

        tracing::info!("[WS] connected — authenticating");

        let mut client = Self { ws };

        // Authenticate
        let auth_msg = serde_json::json!({
            "auth": {
                "server_id": server_id,
                "api_key": api_key,
            }
        });
        client.send_json(&auth_msg).await?;

        // Wait for auth response
        match client.recv_json::<serde_json::Value>().await {
            Ok(msg) => {
                if msg.get("status").and_then(|v| v.as_str()) == Some("ok") {
                    tracing::info!("[WS] authenticated");
                } else {
                    let err = msg.get("error").and_then(|v| v.as_str()).unwrap_or("unknown");
                    anyhow::bail!("WebSocket auth failed: {err}");
                }
            }
            Err(e) => anyhow::bail!("WebSocket auth response error: {e}"),
        }

        Ok(client)
    }

    /// Receive the next command from gv-web.
    pub async fn recv(&mut self) -> Result<ServerCommand> {
        loop {
            let msg = self.recv_json::<serde_json::Value>().await?;
            // Skip non-command messages (pings, acks, etc.)
            if msg.get("type").is_none() {
                continue;
            }
            let cmd: ServerCommand = serde_json::from_value(msg)
                .with_context(|| "failed to parse server command")?;
            return Ok(cmd);
        }
    }

    /// Send a response to gv-web.
    pub async fn send(&mut self, resp: &ServerResponse) -> Result<()> {
        let json = serde_json::to_value(resp)?;
        self.send_json(&json).await
    }

    // ── Internal helpers ──────────────────────────────────────────

    async fn send_json(&mut self, val: &serde_json::Value) -> Result<()> {
        let text = serde_json::to_string(val)?;
        self.ws.send(Message::Text(text.into()))
            .await
            .map_err(|e| anyhow::anyhow!("ws send error: {e}"))?;
        Ok(())
    }

    async fn recv_json<T: serde::de::DeserializeOwned>(&mut self) -> Result<T> {
        loop {
            match self.ws.next().await {
                Some(Ok(Message::Text(text))) => {
                    return serde_json::from_str(&text)
                        .map_err(|e| anyhow::anyhow!("json parse: {e}"));
                }
                Some(Ok(Message::Close(_))) => {
                    anyhow::bail!("WebSocket closed by server");
                }
                Some(Ok(Message::Ping(data))) => {
                    let _ = self.ws.send(Message::Pong(data)).await;
                }
                Some(Ok(_)) => continue, // Binary, Pong — ignore
                Some(Err(e)) => {
                    anyhow::bail!("WebSocket error: {e}");
                }
                None => {
                    anyhow::bail!("WebSocket stream ended");
                }
            }
        }
    }
}
