//! Strict `rom-transfer-v1` control-message contract.
//!
//! The DataChannel label carries the wire version. Text frames are bounded JSON
//! controls; binary frames are ordered file chunks and never parsed as JSON.

use serde::{Deserialize, Serialize};

pub const CHANNEL_LABEL: &str = "rom-transfer-v1";
pub const MAX_CONTROL_MESSAGE_BYTES: usize = 8 * 1024;
pub const MAX_CAPABILITY_SECRET_BYTES: usize = 512;
pub const MAX_ERROR_REASON_BYTES: usize = 1024;
pub const MAX_BINARY_CHUNK_BYTES: usize = 16 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ClientControlState {
    AwaitingAuth,
    Receiving,
}

#[derive(Serialize, Deserialize, Debug, PartialEq, Clone)]
#[serde(tag = "cmd", deny_unknown_fields)]
pub enum TransferMessage {
    #[serde(rename = "auth")]
    Auth { capability_secret: String },
    #[serde(rename = "auth_ok")]
    AuthOk,
    #[serde(rename = "auth_error")]
    AuthError { reason: String },
    #[serde(rename = "transfer_complete")]
    TransferComplete {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        expected_size: Option<u64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        expected_hash: Option<String>,
    },
    #[serde(rename = "transfer_ok")]
    TransferOk {
        hash: String,
        size: u64,
        #[serde(default)]
        game_id: Option<String>,
    },
    #[serde(rename = "transfer_error")]
    TransferError { reason: String },
    #[serde(rename = "cancel")]
    Cancel,
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum ProtocolError {
    #[error("unsupported ROM transfer channel: {0}")]
    UnsupportedChannel(String),
    #[error("control message too large: {actual} > {limit}")]
    ControlTooLarge { actual: usize, limit: usize },
    #[error("invalid ROM transfer control message")]
    InvalidControl,
    #[error("illegal control message for current state")]
    IllegalState,
    #[error("capability secret has invalid length")]
    InvalidCapabilityLength,
    #[error("expected hash must be a 64-character SHA-256 hex digest")]
    InvalidExpectedHash,
}

pub fn validate_channel_label(label: &str) -> Result<(), ProtocolError> {
    if label == CHANNEL_LABEL {
        Ok(())
    } else {
        Err(ProtocolError::UnsupportedChannel(label.to_string()))
    }
}

pub fn decode_client_control(
    data: &[u8],
    state: ClientControlState,
) -> Result<TransferMessage, ProtocolError> {
    if data.len() > MAX_CONTROL_MESSAGE_BYTES {
        return Err(ProtocolError::ControlTooLarge {
            actual: data.len(),
            limit: MAX_CONTROL_MESSAGE_BYTES,
        });
    }

    let message: TransferMessage =
        serde_json::from_slice(data).map_err(|_| ProtocolError::InvalidControl)?;

    match (&message, state) {
        (TransferMessage::Auth { capability_secret }, ClientControlState::AwaitingAuth) => {
            if capability_secret.is_empty() || capability_secret.len() > MAX_CAPABILITY_SECRET_BYTES
            {
                return Err(ProtocolError::InvalidCapabilityLength);
            }
        }
        (
            TransferMessage::TransferComplete { expected_hash, .. },
            ClientControlState::Receiving,
        ) => {
            if let Some(hash) = expected_hash
                && !is_sha256_hex(hash)
            {
                return Err(ProtocolError::InvalidExpectedHash);
            }
        }
        (TransferMessage::Cancel, ClientControlState::Receiving) => {}
        _ => return Err(ProtocolError::IllegalState),
    }

    Ok(message)
}

/// Encode only host-to-browser controls and keep error metadata within the
/// browser parser's bounds. Oversized internal errors become a stable generic
/// error rather than causing the browser to time out on an unreadable reply.
pub fn encode_server_control(message: &TransferMessage) -> Option<String> {
    const BOUNDED_ERROR: &str = "transfer failed; see server logs for details";

    let bounded = match message {
        TransferMessage::AuthOk => TransferMessage::AuthOk,
        TransferMessage::AuthError { reason } => TransferMessage::AuthError {
            reason: if reason.is_empty() || reason.len() > MAX_ERROR_REASON_BYTES {
                BOUNDED_ERROR.to_string()
            } else {
                reason.clone()
            },
        },
        TransferMessage::TransferOk {
            hash,
            size,
            game_id,
        } if is_sha256_hex(hash)
            && game_id
                .as_ref()
                .is_none_or(|value| !value.is_empty() && value.len() <= 512) =>
        {
            TransferMessage::TransferOk {
                hash: hash.clone(),
                size: *size,
                game_id: game_id.clone(),
            }
        }
        TransferMessage::TransferError { reason } => TransferMessage::TransferError {
            reason: if reason.is_empty() || reason.len() > MAX_ERROR_REASON_BYTES {
                BOUNDED_ERROR.to_string()
            } else {
                reason.clone()
            },
        },
        _ => return None,
    };

    let encoded = serde_json::to_string(&bounded).ok()?;
    (encoded.len() <= MAX_CONTROL_MESSAGE_BYTES).then_some(encoded)
}

pub fn is_sha256_hex(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;
    use serde_json::Value;

    #[derive(Deserialize)]
    struct Fixtures {
        channel: ChannelFixtures,
        valid_client_controls: Vec<ClientFixture>,
        invalid_client_controls: Vec<ClientFixture>,
    }

    #[derive(Deserialize)]
    struct ChannelFixtures {
        valid: String,
        invalid: Vec<String>,
    }

    #[derive(Deserialize)]
    struct ClientFixture {
        name: String,
        state: String,
        message: Value,
    }

    fn fixtures() -> Fixtures {
        serde_json::from_str(include_str!(
            "../../../protocol/fixtures/rom-transfer-v1.json"
        ))
        .expect("shared protocol fixtures must be valid JSON")
    }

    fn state(name: &str) -> ClientControlState {
        match name {
            "awaiting_auth" => ClientControlState::AwaitingAuth,
            "receiving" => ClientControlState::Receiving,
            other => panic!("unknown fixture state: {other}"),
        }
    }

    #[test]
    fn shared_fixtures_enforce_channel_version_and_client_controls() {
        let fixtures = fixtures();
        validate_channel_label(&fixtures.channel.valid).unwrap();
        for label in fixtures.channel.invalid {
            assert!(validate_channel_label(&label).is_err());
        }
        for fixture in fixtures.valid_client_controls {
            let encoded = serde_json::to_vec(&fixture.message).unwrap();
            assert!(
                decode_client_control(&encoded, state(&fixture.state)).is_ok(),
                "valid fixture rejected: {}",
                fixture.name
            );
        }
        for fixture in fixtures.invalid_client_controls {
            let encoded = serde_json::to_vec(&fixture.message).unwrap();
            assert!(
                decode_client_control(&encoded, state(&fixture.state)).is_err(),
                "invalid fixture accepted: {}",
                fixture.name
            );
        }
    }

    #[test]
    fn server_error_reasons_are_bounded_for_browser_interoperability() {
        let encoded = encode_server_control(&TransferMessage::TransferError {
            reason: "x".repeat(MAX_ERROR_REASON_BYTES + 1),
        })
        .expect("server error must have a bounded fallback");
        assert!(encoded.len() <= MAX_CONTROL_MESSAGE_BYTES);
        let decoded: TransferMessage = serde_json::from_str(&encoded).unwrap();
        assert!(matches!(
            decoded,
            TransferMessage::TransferError { reason }
                if !reason.is_empty() && reason.len() <= MAX_ERROR_REASON_BYTES
        ));
    }

    #[test]
    fn bounded_controls_reject_oversized_metadata_and_secrets() {
        let oversized = serde_json::to_vec(&serde_json::json!({
            "cmd": "auth",
            "capability_secret": "x".repeat(MAX_CONTROL_MESSAGE_BYTES),
        }))
        .unwrap();
        assert!(decode_client_control(&oversized, ClientControlState::AwaitingAuth).is_err());

        let oversized_secret = serde_json::to_vec(&serde_json::json!({
            "cmd": "auth",
            "capability_secret": "x".repeat(MAX_CAPABILITY_SECRET_BYTES + 1),
        }))
        .unwrap();
        assert!(
            decode_client_control(&oversized_secret, ClientControlState::AwaitingAuth).is_err()
        );
    }
}
