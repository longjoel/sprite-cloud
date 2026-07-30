//! No-media WebRTC ROM transfer session.
//!
//! Architecture: `TransferProtocol` is a pure state machine operating on
//! injectable `TransferSink` + `Responder` traits — fully testable without
//! WebRTC or filesystem.  `TransferSession` is the thin production wrapper
//! that wires a real `RTCPeerConnection` + `RTCDataChannel`.

use crate::rom_transfer::storage::{self, StagedUpload, StorageError};
use crate::sc_web;
use crate::webrtc as webrtc_util;
use sha2::{Digest, Sha256};
use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::Arc;
use tokio::sync::Mutex;

const DC_LABEL: &str = "rom-transfer-v1";
const MAX_CHUNK_SIZE: usize = 256 * 1024;
const MAX_BUFFERED_AMOUNT: usize = 4 * 1024 * 1024;

// ── Protocol messages ──────────────────────────────────────────────────

#[derive(serde::Serialize, serde::Deserialize, Debug, PartialEq, Clone)]
#[serde(tag = "cmd")]
pub enum TransferMessage {
    #[serde(rename = "auth")]
    Auth { capability_secret: String },
    #[serde(rename = "auth_ok")]
    AuthOk,
    #[serde(rename = "auth_error")]
    AuthError { reason: String },
    #[serde(rename = "transfer_complete")]
    TransferComplete {
        #[serde(skip_serializing_if = "Option::is_none")]
        expected_size: Option<u64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        expected_hash: Option<String>,
    },
    #[serde(rename = "transfer_ok")]
    TransferOk {
        hash: String,
        size: u64,
        game_id: Option<String>,
    },
    #[serde(rename = "transfer_error")]
    TransferError { reason: String },
    #[serde(rename = "cancel")]
    Cancel,
}

// ── Protocol state ─────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum ProtocolState {
    AwaitingAuth,
    Receiving,
    Committing,
    Done,
}

// ── Traits ─────────────────────────────────────────────────────────────

pub trait TransferSink: Send {
    fn write_chunk(&mut self, data: &[u8]) -> Result<(), StorageError>;
    fn commit(self: Box<Self>, expected_size: Option<u64>) -> Result<(String, u64), StorageError>;
    fn commit_with_expected_hash(
        self: Box<Self>,
        expected_size: Option<u64>,
        expected_hash: &str,
    ) -> Result<(String, u64), StorageError>;
    fn cancel(self: Box<Self>);
    fn bytes_written(&self) -> u64;
}

#[async_trait::async_trait]
pub trait Responder: Send + Sync {
    async fn send(&self, msg: &TransferMessage);
}

// ── TransferProtocol (pure state machine) ──────────────────────────────

type CommitFuture = Pin<Box<dyn Future<Output = Result<(), String>> + Send>>;
pub type CommitCallback = Arc<dyn Fn() -> CommitFuture + Send + Sync>;

pub struct TransferProtocol {
    capability_hash: String,
    state: Mutex<ProtocolState>,
    sink: Mutex<Option<Box<dyn TransferSink>>>,
    responder: Arc<dyn Responder>,
    bytes_received: Mutex<u64>,
    authorized_size: u64,
    on_commit: Option<CommitCallback>,
}

impl TransferProtocol {
    pub fn new(
        capability_hash: String,
        sink: Box<dyn TransferSink>,
        responder: Arc<dyn Responder>,
        authorized_size: u64,
        on_commit: Option<CommitCallback>,
    ) -> Self {
        Self {
            capability_hash,
            state: Mutex::new(ProtocolState::AwaitingAuth),
            sink: Mutex::new(Some(sink)),
            responder,
            bytes_received: Mutex::new(0),
            authorized_size,
            on_commit,
        }
    }

    pub async fn handle_message(&self, data: &[u8]) {
        let state = *self.state.lock().await;
        match state {
            ProtocolState::AwaitingAuth => self.handle_auth(data).await,
            ProtocolState::Receiving => self.handle_receiving(data).await,
            _ => {}
        }
    }

    pub async fn state(&self) -> ProtocolState {
        *self.state.lock().await
    }

    pub async fn bytes_received(&self) -> u64 {
        *self.bytes_received.lock().await
    }

    async fn handle_auth(&self, data: &[u8]) {
        let msg: TransferMessage = match serde_json::from_slice(data) {
            Ok(m) => m,
            Err(_) => {
                self.responder
                    .send(&TransferMessage::AuthError {
                        reason: "invalid JSON".into(),
                    })
                    .await;
                return;
            }
        };
        let TransferMessage::Auth { capability_secret } = msg else {
            self.responder
                .send(&TransferMessage::AuthError {
                    reason: "expected auth message".into(),
                })
                .await;
            return;
        };
        let computed = hex::encode(Sha256::digest(capability_secret.as_bytes()));
        if !storage::constant_time_eq(computed.as_bytes(), self.capability_hash.as_bytes()) {
            self.responder
                .send(&TransferMessage::AuthError {
                    reason: "invalid capability".into(),
                })
                .await;
            *self.state.lock().await = ProtocolState::Done;
            return;
        }
        *self.state.lock().await = ProtocolState::Receiving;
        self.responder.send(&TransferMessage::AuthOk).await;
    }

    async fn handle_receiving(&self, data: &[u8]) {
        if let Ok(msg) = serde_json::from_slice::<TransferMessage>(data) {
            match msg {
                TransferMessage::TransferComplete {
                    expected_size,
                    expected_hash,
                } => {
                    self.handle_complete(expected_size, expected_hash).await;
                }
                TransferMessage::Cancel => {
                    self.handle_cancel().await;
                }
                _ => {}
            }
            return;
        }
        if data.len() > MAX_CHUNK_SIZE {
            self.responder
                .send(&TransferMessage::TransferError {
                    reason: format!("chunk too large: {} > {MAX_CHUNK_SIZE}", data.len()),
                })
                .await;
            *self.state.lock().await = ProtocolState::Done;
            return;
        }
        let mut received = self.bytes_received.lock().await;
        let attempted_size = (*received).saturating_add(data.len() as u64);
        if attempted_size > self.authorized_size {
            drop(received);
            if let Some(sink) = self.sink.lock().await.take() {
                sink.cancel();
            }
            self.responder
                .send(&TransferMessage::TransferError {
                    reason: format!(
                        "upload exceeds authorized size of {} bytes",
                        self.authorized_size
                    ),
                })
                .await;
            *self.state.lock().await = ProtocolState::Done;
            return;
        }
        let mut sink_guard = self.sink.lock().await;
        match sink_guard.as_mut() {
            Some(sink) => {
                if let Err(e) = sink.write_chunk(data) {
                    drop(sink_guard);
                    self.responder
                        .send(&TransferMessage::TransferError {
                            reason: format!("write error: {e}"),
                        })
                        .await;
                    *self.state.lock().await = ProtocolState::Done;
                    return;
                }
                *received = attempted_size;
            }
            None => {
                self.responder
                    .send(&TransferMessage::TransferError {
                        reason: "no active upload".into(),
                    })
                    .await;
                *self.state.lock().await = ProtocolState::Done;
            }
        }
    }

    async fn handle_complete(
        &self,
        _client_expected_size: Option<u64>,
        expected_hash: Option<String>,
    ) {
        *self.state.lock().await = ProtocolState::Committing;
        let expected_size = Some(self.authorized_size);
        let sink = { self.sink.lock().await.take() };
        let sink = match sink {
            Some(s) => s,
            None => {
                self.responder
                    .send(&TransferMessage::TransferError {
                        reason: "no upload to commit".into(),
                    })
                    .await;
                *self.state.lock().await = ProtocolState::Done;
                return;
            }
        };
        let result = if let Some(ref expected) = expected_hash {
            sink.commit_with_expected_hash(expected_size, expected)
        } else {
            sink.commit(expected_size)
        };
        match result {
            Ok((hash, size)) => {
                if let Some(ref cb) = self.on_commit
                    && let Err(error) = cb().await
                {
                    self.responder
                        .send(&TransferMessage::TransferError {
                            reason: format!("ROM committed, but catalog refresh failed: {error}"),
                        })
                        .await;
                    *self.state.lock().await = ProtocolState::Done;
                    return;
                }
                self.responder
                    .send(&TransferMessage::TransferOk {
                        hash,
                        size,
                        game_id: None,
                    })
                    .await;
            }
            Err(e) => {
                self.responder
                    .send(&TransferMessage::TransferError {
                        reason: format!("commit error: {e}"),
                    })
                    .await;
            }
        }
        *self.state.lock().await = ProtocolState::Done;
    }

    async fn handle_cancel(&self) {
        if let Some(sink) = self.sink.lock().await.take() {
            sink.cancel();
        }
        *self.state.lock().await = ProtocolState::Done;
    }
}

// ── TransferSession (WebRTC integration) ───────────────────────────────

/// Wraps a live DC as a `Responder`.
struct DcResponder {
    dc: Mutex<Option<Arc<::webrtc::data_channel::RTCDataChannel>>>,
}

#[async_trait::async_trait]
impl Responder for DcResponder {
    async fn send(&self, msg: &TransferMessage) {
        let json = match serde_json::to_string(msg) {
            Ok(j) => j,
            Err(_) => return,
        };
        if let Some(ref dc) = *self.dc.lock().await {
            let _ = dc.send_text(json).await;
        }
    }
}

pub struct TransferSession {
    pc: Arc<::webrtc::peer_connection::RTCPeerConnection>,
    transfer_id: String,
    rom_root: PathBuf,
}

#[derive(Debug, Clone)]
pub struct TransferConstraints {
    pub basename: String,
    pub declared_size: u64,
    pub platform_hint: Option<String>,
}

impl TransferSession {
    pub async fn new(transfer_id: String, rom_root: PathBuf) -> Result<Self, String> {
        let pc = webrtc_util::build_pc_for_guest().await?;
        Ok(Self {
            pc,
            transfer_id,
            rom_root,
        })
    }

    pub async fn exchange_sdp(&self, offer_sdp: &str) -> Result<String, String> {
        webrtc_util::exchange_sdp_on_pc(&self.pc, offer_sdp).await
    }

    /// Wire on_data_channel and create the protocol inside the callback.
    /// Returns immediately; the protocol runs inside webrtc callbacks.
    pub fn wire(
        self: &Arc<Self>,
        capability_hash: String,
        constraints: TransferConstraints,
        on_commit: CommitCallback,
    ) {
        let session = Arc::clone(self);
        let rom_root = self.rom_root.clone();
        let commit_callback = Arc::clone(&on_commit);
        self.pc.on_data_channel(Box::new(
            move |dc: Arc<::webrtc::data_channel::RTCDataChannel>| {
                let sess = Arc::clone(&session);
                let root = rom_root.clone();
                let cap_hash = capability_hash.clone();
                let cons = constraints.clone();
                let on_commit = Arc::clone(&commit_callback);
                Box::pin(async move {
                    if dc.label() != DC_LABEL {
                        tracing::warn!("[ROM XFER] unexpected DC label: {} — ignoring", dc.label());
                        return;
                    }
                    tracing::info!("[ROM XFER] data channel received: {}", dc.id());

                    let responder = Arc::new(DcResponder {
                        dc: Mutex::new(Some(Arc::clone(&dc))),
                    });
                    let sink: Box<dyn TransferSink> =
                        match StagedUpload::create(&root, &cons.basename, cons.declared_size) {
                            Ok(upload) => Box::new(StagedUploadSink {
                                upload: Mutex::new(Some(upload)),
                            }),
                            Err(e) => {
                                tracing::error!("[ROM XFER] failed to create staged upload: {e}");
                                let resp = DcResponder {
                                    dc: Mutex::new(Some(Arc::clone(&dc))),
                                };
                                resp.send(&TransferMessage::AuthError {
                                    reason: format!("storage error: {e}"),
                                })
                                .await;
                                return;
                            }
                        };
                    let protocol = Arc::new(TransferProtocol::new(
                        cap_hash,
                        sink,
                        responder,
                        cons.declared_size,
                        Some(on_commit),
                    ));

                    dc.set_buffered_amount_low_threshold(MAX_BUFFERED_AMOUNT)
                        .await;

                    dc.on_open(Box::new(move || {
                        tracing::info!("[ROM XFER] data channel opened");
                        Box::pin(async move {})
                    }));

                    dc.on_close(Box::new({
                        let s = Arc::clone(&sess);
                        move || {
                            let s = Arc::clone(&s);
                            Box::pin(async move {
                                tracing::warn!("[ROM XFER] data channel closed unexpectedly");
                                let _ = s.pc.close().await;
                            })
                        }
                    }));

                    dc.on_error(Box::new(move |err| {
                        let err_str = err.to_string();
                        Box::pin(async move {
                            tracing::error!("[ROM XFER] data channel error: {err_str}")
                        })
                    }));

                    dc.on_message(Box::new(move |msg| {
                        let proto = Arc::clone(&protocol);
                        let data = msg.data.to_vec();
                        Box::pin(async move { proto.handle_message(&data).await })
                    }));
                })
            },
        ));
    }

    pub fn transfer_id(&self) -> &str {
        &self.transfer_id
    }
}

// ── StagedUpload wrapper ───────────────────────────────────────────────

/// Adapts `StagedUpload` to the `TransferSink` trait.
struct StagedUploadSink {
    upload: Mutex<Option<StagedUpload>>,
}

impl TransferSink for StagedUploadSink {
    fn write_chunk(&mut self, data: &[u8]) -> Result<(), StorageError> {
        // Need &self not &mut self for trait, but StagedUpload::write_chunk takes &mut
        // Use block_on to get the mutex guard
        let mut guard = self
            .upload
            .try_lock()
            .map_err(|_| StorageError::Io(std::io::Error::other("lock contention")))?;
        guard
            .as_mut()
            .ok_or_else(|| StorageError::Io(std::io::Error::other("upload already consumed")))?
            .write_chunk(data)
    }

    fn commit(self: Box<Self>, expected_size: Option<u64>) -> Result<(String, u64), StorageError> {
        self.upload
            .into_inner()
            .ok_or_else(|| StorageError::Io(std::io::Error::other("upload already consumed")))?
            .commit(expected_size)
    }

    fn commit_with_expected_hash(
        self: Box<Self>,
        expected_size: Option<u64>,
        expected_hash: &str,
    ) -> Result<(String, u64), StorageError> {
        self.upload
            .into_inner()
            .ok_or_else(|| StorageError::Io(std::io::Error::other("upload already consumed")))?
            .commit_with_expected_hash(expected_size, expected_hash)
    }

    fn cancel(self: Box<Self>) {
        if let Some(upload) = self.upload.into_inner() {
            let _ = upload.cancel();
        }
    }

    fn bytes_written(&self) -> u64 {
        self.upload
            .try_lock()
            .ok()
            .and_then(|g| g.as_ref().map(|u| u.bytes_written()))
            .unwrap_or(0)
    }
}

// ── Command handler ────────────────────────────────────────────────────

pub(crate) async fn handle_rom_transfer(
    cmd: &sc_web::Command,
    client: &sc_web::ScWebClient,
    rom_roots: &[String],
    local_game_list: Arc<tokio::sync::RwLock<Vec<crate::player_server::LocalGame>>>,
    library_preferences: crate::player_server::SharedLibraryState,
    catalog_sync_lock: Arc<tokio::sync::Mutex<()>>,
) {
    let transfer_id = cmd
        .payload
        .get("transfer_id")
        .and_then(|v| v.as_str())
        .unwrap_or("unknown");
    let capability_hash = match cmd.payload.get("capability_hash").and_then(|v| v.as_str()) {
        Some(h) => h.to_string(),
        None => {
            let _ = client
                .command_result(
                    &cmd.id,
                    &cmd.lease_token,
                    &serde_json::json!({"error": "missing capability_hash"}),
                )
                .await;
            return;
        }
    };
    let sdp_offer = match cmd.payload.get("sdp").and_then(|v| v.as_str()) {
        Some(s) => s.to_string(),
        None => {
            let _ = client
                .command_result(
                    &cmd.id,
                    &cmd.lease_token,
                    &serde_json::json!({"error": "missing sdp"}),
                )
                .await;
            return;
        }
    };
    let constraints = {
        let c = cmd.payload.get("constraints").and_then(|v| v.as_object());
        match c {
            Some(obj) => TransferConstraints {
                basename: obj
                    .get("basename")
                    .and_then(|v| v.as_str())
                    .unwrap_or("unknown.rom")
                    .to_string(),
                declared_size: obj
                    .get("declared_size")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0),
                platform_hint: obj
                    .get("platform_hint")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string()),
            },
            None => {
                let _ = client
                    .command_result(
                        &cmd.id,
                        &cmd.lease_token,
                        &serde_json::json!({"error": "missing constraints"}),
                    )
                    .await;
                return;
            }
        }
    };

    tracing::info!(
        "[ROM XFER] transfer_id={transfer_id} basename={} size={}",
        constraints.basename,
        constraints.declared_size
    );

    let rom_root = match storage::select_import_root(rom_roots) {
        Ok(r) => r,
        Err(e) => {
            let _ = client
                .command_result(
                    &cmd.id,
                    &cmd.lease_token,
                    &serde_json::json!({"error": "no writable ROM root", "detail": e.to_string()}),
                )
                .await;
            return;
        }
    };
    let session = match TransferSession::new(transfer_id.to_string(), rom_root).await {
        Ok(s) => Arc::new(s),
        Err(e) => {
            let _ = client
                .command_result(
                    &cmd.id,
                    &cmd.lease_token,
                    &serde_json::json!({"error": "session creation failed", "detail": e}),
                )
                .await;
            return;
        }
    };

    let refresh_client = client.clone();
    let refresh_roots = rom_roots.to_vec();
    let on_commit: CommitCallback = Arc::new(move || {
        let client = refresh_client.clone();
        let roots = refresh_roots.clone();
        let games = Arc::clone(&local_game_list);
        let preferences = Arc::clone(&library_preferences);
        let sync_lock = Arc::clone(&catalog_sync_lock);
        Box::pin(async move {
            let _guard = sync_lock.lock().await;
            let scanned = crate::commands::scan_library(&roots);
            {
                let mut current = games.write().await;
                *current = scanned;
            }
            let games_snapshot = games.read().await.clone();
            let preferences_snapshot = preferences.lock().await.snapshot();
            crate::commands::sync_catalog(&client, &games_snapshot, &preferences_snapshot)
                .await
                .map_err(|error| format!("{error:#}"))
        })
    });

    session.wire(capability_hash.clone(), constraints, on_commit);

    let answer_sdp = match session.exchange_sdp(&sdp_offer).await {
        Ok(a) => a,
        Err(e) => {
            let _ = client
                .command_result(
                    &cmd.id,
                    &cmd.lease_token,
                    &serde_json::json!({"error": "sdp exchange failed", "detail": e}),
                )
                .await;
            return;
        }
    };
    if let Err(e) = client
        .notify_sdp(
            &cmd.id,
            &cmd.lease_token,
            "",
            transfer_id,
            &answer_sdp,
            None,
        )
        .await
    {
        tracing::error!("[ROM XFER] failed to notify SDP answer: {e}");
        return;
    }
    tracing::info!("[ROM XFER] SDP answer delivered for transfer_id={transfer_id}");
}

// ═══════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex as StdMutex;
    use std::sync::atomic::{AtomicBool, Ordering};

    // ── Fake implementations ────────────────────────────────────────

    struct FakeSink {
        chunks: StdMutex<Vec<Vec<u8>>>,
        cancelled: StdMutex<bool>,
    }

    impl FakeSink {
        fn new() -> Self {
            Self {
                chunks: StdMutex::new(Vec::new()),
                cancelled: StdMutex::new(false),
            }
        }
        fn chunks(&self) -> Vec<Vec<u8>> {
            self.chunks.lock().unwrap().clone()
        }
        fn was_cancelled(&self) -> bool {
            *self.cancelled.lock().unwrap()
        }
    }

    impl TransferSink for FakeSink {
        fn write_chunk(&mut self, data: &[u8]) -> Result<(), StorageError> {
            self.chunks.lock().unwrap().push(data.to_vec());
            Ok(())
        }
        fn commit(
            self: Box<Self>,
            expected_size: Option<u64>,
        ) -> Result<(String, u64), StorageError> {
            let total: usize = self.chunks.lock().unwrap().iter().map(|c| c.len()).sum();
            if let Some(declared) = expected_size
                && declared != total as u64
            {
                return Err(StorageError::SizeMismatch {
                    declared,
                    actual: total as u64,
                });
            }
            Ok(("deadbeef".into(), total as u64))
        }
        fn commit_with_expected_hash(
            self: Box<Self>,
            sz: Option<u64>,
            _: &str,
        ) -> Result<(String, u64), StorageError> {
            self.commit(sz)
        }
        fn cancel(self: Box<Self>) {
            *self.cancelled.lock().unwrap() = true;
        }
        fn bytes_written(&self) -> u64 {
            self.chunks
                .lock()
                .unwrap()
                .iter()
                .map(|c| c.len() as u64)
                .sum()
        }
    }

    struct FakeResponder {
        messages: StdMutex<Vec<TransferMessage>>,
    }

    impl FakeResponder {
        fn new() -> Self {
            Self {
                messages: StdMutex::new(Vec::new()),
            }
        }
        fn messages(&self) -> Vec<TransferMessage> {
            self.messages.lock().unwrap().clone()
        }
        fn last(&self) -> Option<TransferMessage> {
            self.messages.lock().unwrap().last().cloned()
        }
    }

    #[async_trait::async_trait]
    impl Responder for FakeResponder {
        async fn send(&self, msg: &TransferMessage) {
            self.messages.lock().unwrap().push(msg.clone());
        }
    }

    // ── Helpers ─────────────────────────────────────────────────────

    fn auth_msg(secret: &str) -> Vec<u8> {
        serde_json::to_vec(&TransferMessage::Auth {
            capability_secret: secret.into(),
        })
        .unwrap()
    }
    fn complete_msg(size: Option<u64>, hash: Option<&str>) -> Vec<u8> {
        serde_json::to_vec(&TransferMessage::TransferComplete {
            expected_size: size,
            expected_hash: hash.map(|s| s.to_string()),
        })
        .unwrap()
    }
    fn cancel_msg() -> Vec<u8> {
        serde_json::to_vec(&TransferMessage::Cancel).unwrap()
    }
    fn cap_hash(secret: &str) -> String {
        hex::encode(Sha256::digest(secret.as_bytes()))
    }
    fn build_protocol(hash: &str, responder: Arc<FakeResponder>) -> TransferProtocol {
        TransferProtocol::new(
            hash.to_string(),
            Box::new(FakeSink::new()),
            responder,
            u64::MAX,
            None,
        )
    }

    // ═══════════════════════════════════════════════════════════════
    // Capability redemption
    // ═══════════════════════════════════════════════════════════════

    #[tokio::test]
    async fn auth_correct_secret_succeeds() {
        let secret = "test-capability";
        let hash = cap_hash(secret);
        let responder = Arc::new(FakeResponder::new());
        let proto = build_protocol(&hash, Arc::clone(&responder));
        proto.handle_message(&auth_msg(secret)).await;
        assert_eq!(proto.state().await, ProtocolState::Receiving);
        assert!(matches!(responder.last().unwrap(), TransferMessage::AuthOk));
    }

    #[tokio::test]
    async fn auth_wrong_secret_rejected() {
        let hash = cap_hash("correct");
        let responder = Arc::new(FakeResponder::new());
        let proto = build_protocol(&hash, Arc::clone(&responder));
        proto.handle_message(&auth_msg("wrong")).await;
        assert_eq!(proto.state().await, ProtocolState::Done);
        assert!(matches!(
            responder.last().unwrap(),
            TransferMessage::AuthError { .. }
        ));
    }

    #[tokio::test]
    async fn auth_empty_secret_rejected() {
        let hash = cap_hash("real");
        let responder = Arc::new(FakeResponder::new());
        let proto = build_protocol(&hash, Arc::clone(&responder));
        proto.handle_message(&auth_msg("")).await;
        assert_eq!(proto.state().await, ProtocolState::Done);
    }

    #[tokio::test]
    async fn auth_twice_second_ignored() {
        let secret = "secret";
        let hash = cap_hash(secret);
        let responder = Arc::new(FakeResponder::new());
        let proto = build_protocol(&hash, Arc::clone(&responder));
        proto.handle_message(&auth_msg(secret)).await;
        assert_eq!(proto.state().await, ProtocolState::Receiving);
        // Second auth message — parsed as JSON, but state is Receiving so
        // handle_receiving runs; TransferMessage::Auth is not Complete/Cancel → ignored
        proto.handle_message(&auth_msg(secret)).await;
        assert_eq!(proto.state().await, ProtocolState::Receiving);
    }

    // ═══════════════════════════════════════════════════════════════
    // Chunk handling
    // ═══════════════════════════════════════════════════════════════

    #[tokio::test]
    async fn chunks_before_auth_ignored() {
        let hash = cap_hash("secret");
        let responder = Arc::new(FakeResponder::new());
        let sink = FakeSink::new();
        let proto = TransferProtocol::new(
            hash,
            Box::new(sink),
            Arc::clone(&responder) as Arc<dyn Responder>,
            u64::MAX,
            None,
        );
        proto.handle_message(b"binary junk").await;
        assert_eq!(proto.state().await, ProtocolState::AwaitingAuth);
    }

    #[tokio::test]
    async fn chunks_after_auth_accumulated() {
        let secret = "secret";
        let hash = cap_hash(secret);
        let responder = Arc::new(FakeResponder::new());
        let proto = build_protocol(&hash, Arc::clone(&responder));
        proto.handle_message(&auth_msg(secret)).await;
        proto.handle_message(&[0u8; 100]).await;
        proto.handle_message(&[1u8; 200]).await;
        assert_eq!(proto.bytes_received().await, 300);
        assert_eq!(proto.state().await, ProtocolState::Receiving);
    }

    #[tokio::test]
    async fn cumulative_chunks_cannot_exceed_authorized_size() {
        let secret = "secret";
        let responder = Arc::new(FakeResponder::new());
        let proto = TransferProtocol::new(
            cap_hash(secret),
            Box::new(FakeSink::new()),
            Arc::clone(&responder) as Arc<dyn Responder>,
            4,
            None,
        );
        proto.handle_message(&auth_msg(secret)).await;
        proto.handle_message(b"123").await;
        proto.handle_message(b"45").await;
        assert_eq!(proto.bytes_received().await, 3);
        assert_eq!(proto.state().await, ProtocolState::Done);
        assert!(matches!(
            responder.last(),
            Some(TransferMessage::TransferError { .. })
        ));
    }

    #[tokio::test]
    async fn oversized_chunk_rejected() {
        let secret = "secret";
        let hash = cap_hash(secret);
        let responder = Arc::new(FakeResponder::new());
        let proto = build_protocol(&hash, Arc::clone(&responder));
        proto.handle_message(&auth_msg(secret)).await;
        let big = vec![0u8; MAX_CHUNK_SIZE + 1];
        proto.handle_message(&big).await;
        assert_eq!(proto.state().await, ProtocolState::Done);
        assert!(
            responder
                .messages()
                .iter()
                .any(|m| matches!(m, TransferMessage::TransferError { .. }))
        );
    }

    // ═══════════════════════════════════════════════════════════════
    // Transfer complete
    // ═══════════════════════════════════════════════════════════════

    #[tokio::test]
    async fn transfer_complete_after_auth_commits_and_done() {
        let secret = "secret";
        let hash = cap_hash(secret);
        let responder = Arc::new(FakeResponder::new());
        let proto = TransferProtocol::new(
            hash,
            Box::new(FakeSink::new()),
            Arc::clone(&responder) as Arc<dyn Responder>,
            42,
            None,
        );
        proto.handle_message(&auth_msg(secret)).await;
        proto.handle_message(&[1u8; 42]).await;
        proto.handle_message(&complete_msg(None, None)).await;
        assert_eq!(proto.state().await, ProtocolState::Done);
        let msgs = responder.messages();
        assert!(
            msgs.iter()
                .any(|m| matches!(m, TransferMessage::TransferOk { size: 42, .. }))
        );
    }

    #[tokio::test]
    async fn transfer_ok_waits_for_successful_catalog_refresh() {
        let secret = "secret";
        let responder = Arc::new(FakeResponder::new());
        let refreshed = Arc::new(AtomicBool::new(false));
        let refreshed_for_hook = Arc::clone(&refreshed);
        let hook: CommitCallback = Arc::new(move || {
            let refreshed = Arc::clone(&refreshed_for_hook);
            Box::pin(async move {
                refreshed.store(true, Ordering::SeqCst);
                Ok(())
            })
        });
        let proto = TransferProtocol::new(
            cap_hash(secret),
            Box::new(FakeSink::new()),
            Arc::clone(&responder) as Arc<dyn Responder>,
            4,
            Some(hook),
        );
        proto.handle_message(&auth_msg(secret)).await;
        proto.handle_message(b"TEST").await;
        proto.handle_message(&complete_msg(None, None)).await;
        assert!(refreshed.load(Ordering::SeqCst));
        assert!(matches!(
            responder.last(),
            Some(TransferMessage::TransferOk { .. })
        ));
    }

    #[tokio::test]
    async fn catalog_refresh_failure_is_not_reported_as_transfer_success() {
        let secret = "secret";
        let responder = Arc::new(FakeResponder::new());
        let hook: CommitCallback = Arc::new(|| Box::pin(async { Err("sync unavailable".into()) }));
        let proto = TransferProtocol::new(
            cap_hash(secret),
            Box::new(FakeSink::new()),
            Arc::clone(&responder) as Arc<dyn Responder>,
            4,
            Some(hook),
        );
        proto.handle_message(&auth_msg(secret)).await;
        proto.handle_message(b"TEST").await;
        proto.handle_message(&complete_msg(None, None)).await;
        assert!(matches!(
            responder.last(),
            Some(TransferMessage::TransferError { .. })
        ));
        assert!(
            !responder
                .messages()
                .iter()
                .any(|msg| matches!(msg, TransferMessage::TransferOk { .. }))
        );
    }

    #[tokio::test]
    async fn transfer_complete_before_auth_error() {
        let hash = cap_hash("secret");
        let responder = Arc::new(FakeResponder::new());
        let proto = build_protocol(&hash, Arc::clone(&responder));
        proto.handle_message(&complete_msg(None, None)).await;
        // In AwaitingAuth, handle_auth parses it — not Auth → error
        assert_eq!(proto.state().await, ProtocolState::AwaitingAuth);
        assert!(
            responder
                .messages()
                .iter()
                .any(|m| matches!(m, TransferMessage::AuthError { .. }))
        );
    }

    // ═══════════════════════════════════════════════════════════════
    // Cancellation
    // ═══════════════════════════════════════════════════════════════

    #[tokio::test]
    async fn cancel_after_auth_transitions_to_done() {
        let secret = "secret";
        let hash = cap_hash(secret);
        let responder = Arc::new(FakeResponder::new());
        let proto = build_protocol(&hash, Arc::clone(&responder));
        proto.handle_message(&auth_msg(secret)).await;
        assert_eq!(proto.state().await, ProtocolState::Receiving);
        proto.handle_message(&cancel_msg()).await;
        assert_eq!(proto.state().await, ProtocolState::Done);
    }

    #[tokio::test]
    async fn cancel_before_auth_no_effect() {
        let hash = cap_hash("secret");
        let responder = Arc::new(FakeResponder::new());
        let proto = build_protocol(&hash, Arc::clone(&responder));
        proto.handle_message(&cancel_msg()).await;
        assert_eq!(proto.state().await, ProtocolState::AwaitingAuth);
    }

    // ═══════════════════════════════════════════════════════════════
    // Invalid JSON
    // ═══════════════════════════════════════════════════════════════

    #[tokio::test]
    async fn auth_invalid_json_rejected() {
        let hash = cap_hash("secret");
        let responder = Arc::new(FakeResponder::new());
        let proto = build_protocol(&hash, Arc::clone(&responder));
        proto.handle_message(b"not json {{").await;
        assert_eq!(proto.state().await, ProtocolState::AwaitingAuth);
        assert!(
            matches!(responder.last().unwrap(), TransferMessage::AuthError { ref reason } if reason == "invalid JSON")
        );
    }

    // ═══════════════════════════════════════════════════════════════
    // State transitions
    // ═══════════════════════════════════════════════════════════════

    #[tokio::test]
    async fn full_state_machine_flow() {
        let secret = "secret";
        let hash = cap_hash(secret);
        let responder = Arc::new(FakeResponder::new());
        let proto = build_protocol(&hash, Arc::clone(&responder));
        assert_eq!(proto.state().await, ProtocolState::AwaitingAuth);
        proto.handle_message(&auth_msg(secret)).await;
        assert_eq!(proto.state().await, ProtocolState::Receiving);
        proto.handle_message(&cancel_msg()).await;
        assert_eq!(proto.state().await, ProtocolState::Done);
    }

    #[tokio::test]
    async fn messages_ignored_in_done_state() {
        let secret = "secret";
        let hash = cap_hash(secret);
        let responder = Arc::new(FakeResponder::new());
        let proto = build_protocol(&hash, Arc::clone(&responder));
        proto.handle_message(&auth_msg(secret)).await;
        proto.handle_message(&cancel_msg()).await;
        assert_eq!(proto.state().await, ProtocolState::Done);
        let count_before = responder.messages().len();
        proto.handle_message(b"more data").await;
        proto.handle_message(&auth_msg("replay")).await;
        assert_eq!(responder.messages().len(), count_before); // no new responses
    }

    // ═══════════════════════════════════════════════════════════════
    // Replay prevention
    // ═══════════════════════════════════════════════════════════════

    #[tokio::test]
    async fn replay_attack_prevented() {
        // Each transfer has a unique capability hash. Secret-A works for protocol-A
        // but not for protocol-B.
        let hash_a = cap_hash("secret-A");
        let resp_a = Arc::new(FakeResponder::new());
        let proto_a = build_protocol(&hash_a, Arc::clone(&resp_a));
        proto_a.handle_message(&auth_msg("secret-A")).await;
        assert_eq!(proto_a.state().await, ProtocolState::Receiving);

        let hash_b = cap_hash("secret-B");
        let resp_b = Arc::new(FakeResponder::new());
        let proto_b = build_protocol(&hash_b, Arc::clone(&resp_b));
        proto_b.handle_message(&auth_msg("secret-A")).await;
        assert_eq!(proto_b.state().await, ProtocolState::Done);
        assert!(matches!(
            resp_b.last().unwrap(),
            TransferMessage::AuthError { .. }
        ));
    }

    // ═══════════════════════════════════════════════════════════════
    // Message serialization
    // ═══════════════════════════════════════════════════════════════

    #[test]
    fn message_roundtrip_auth() {
        let m = TransferMessage::Auth {
            capability_secret: "s".into(),
        };
        let json = serde_json::to_string(&m).unwrap();
        assert_eq!(serde_json::from_str::<TransferMessage>(&json).unwrap(), m);
    }

    #[test]
    fn message_roundtrip_complete() {
        let m = TransferMessage::TransferComplete {
            expected_size: Some(42),
            expected_hash: Some("abc".into()),
        };
        let json = serde_json::to_string(&m).unwrap();
        assert_eq!(serde_json::from_str::<TransferMessage>(&json).unwrap(), m);
    }
}
