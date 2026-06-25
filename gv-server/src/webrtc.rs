//! WebRTC stack: pre-warming, PC building, SDP exchange, ICE gathering.
//!
//! Adapted from gv-worker/src/main_body/webrtc.rs — all worker-specific
//! code (GStreamer encoders, core loading, DC auth handler) removed.
//!
//! Provides a single `handle_sdp_offer()` entry point that takes a browser
//! SDP offer and returns the answer SDP + peer connection + tracks.

use std::net::IpAddr;
use std::sync::Arc;
use std::time::Duration;

use webrtc::api::interceptor_registry::register_default_interceptors;
use webrtc::api::media_engine::{MediaEngine, MIME_TYPE_H264, MIME_TYPE_OPUS, MIME_TYPE_VP8};
use webrtc::api::setting_engine::SettingEngine;
use webrtc::api::APIBuilder;
use webrtc::ice_transport::ice_server::RTCIceServer;
use webrtc::ice::network_type::NetworkType;
use webrtc::ice::mdns::MulticastDnsMode;
use webrtc::peer_connection::configuration::RTCConfiguration;
use webrtc::ice_transport::ice_gatherer_state::RTCIceGathererState;
use webrtc::peer_connection::policy::ice_transport_policy::RTCIceTransportPolicy;
use webrtc::peer_connection::sdp::session_description::RTCSessionDescription;
use webrtc::peer_connection::RTCPeerConnection;
use webrtc::rtp_transceiver::rtp_codec::RTCRtpCodecCapability;
use webrtc::track::track_local::track_local_static_sample::TrackLocalStaticSample;
use webrtc::track::track_local::TrackLocal;

// ── Constants ────────────────────────────────────────────────────────────────

const AUDIO_SAMPLE_RATE: u32 = 48_000;
const AUDIO_CHANNELS: u16 = 2;
const OPUS_SDP_FMTP: &str = "minptime=10;useinbandfec=1";
const VIDEO_TRACK_ID: &str = "video";
const AUDIO_TRACK_ID: &str = "audio";
const STREAM_ID: &str = "stream";
const VP8_CLOCK_RATE: u32 = 90_000;
const ICE_GATHERING_TIMEOUT_SECS: u64 = 30;

// ── Codec enum ───────────────────────────────────────────────────────────────

/// Video codec to use for the WebRTC track.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VideoCodec {
    Vp8,
    H264,
}

// ── ICE config ───────────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq)]
struct IceServer {
    urls: Vec<String>,
    username: Option<String>,
    credential: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum IceTransportPolicy {
    All,
    Relay,
}

#[derive(Debug, Clone, PartialEq)]
struct IceConfig {
    servers: Vec<IceServer>,
    transport_policy: IceTransportPolicy,
}

/// Build ICE configuration from environment variables.
///
/// Reads `GV_ICE_STUN_URLS`, `GV_ICE_TURN_URLS`, `GV_ICE_TURN_USERNAME`,
/// `GV_ICE_TURN_CREDENTIAL`, and `GV_ICE_TRANSPORT_POLICY`.  Falls back
/// to Google's public STUN if nothing is configured.
fn ice_config() -> IceConfig {
    let stun_urls: Vec<String> = std::env::var("GV_ICE_STUN_URLS")
        .ok()
        .map(|s| {
            s.split(',')
                .map(|p| p.trim().to_string())
                .filter(|p| !p.is_empty())
                .collect()
        })
        .unwrap_or_default();

    let turn_urls: Vec<String> = std::env::var("GV_ICE_TURN_URLS")
        .ok()
        .map(|s| {
            s.split(',')
                .map(|p| p.trim().to_string())
                .filter(|p| !p.is_empty())
                .collect()
        })
        .unwrap_or_default();

    let turn_username = std::env::var("GV_ICE_TURN_USERNAME").ok();
    let turn_credential = std::env::var("GV_ICE_TURN_CREDENTIAL").ok();
    let policy = match std::env::var("GV_ICE_TRANSPORT_POLICY")
        .ok()
        .as_deref()
    {
        Some("relay") => IceTransportPolicy::Relay,
        _ => IceTransportPolicy::All,
    };

    let mut servers = Vec::new();
    if !stun_urls.is_empty() {
        servers.push(IceServer {
            urls: stun_urls,
            username: None,
            credential: None,
        });
    }
    if !turn_urls.is_empty() {
        servers.push(IceServer {
            urls: turn_urls,
            username: turn_username.filter(|s| !s.is_empty()),
            credential: turn_credential.filter(|s| !s.is_empty()),
        });
    }
    if servers.is_empty() {
        servers.push(IceServer {
            urls: vec!["stun:stun.l.google.com:19302".into()],
            username: None,
            credential: None,
        });
    }

    IceConfig {
        servers,
        transport_policy: policy,
    }
}

// ── Internal helpers ─────────────────────────────────────────────────────────

/// Build a fully-configured RTCPeerConnection with video + audio tracks.
async fn build_webrtc_stack(video_codec: VideoCodec) -> Result<InternalWebRtcStack, String> {
    let mut media_engine = MediaEngine::default();
    media_engine
        .register_default_codecs()
        .map_err(|e| format!("register codecs: {e}"))?;

    let mut registry = webrtc::interceptor::registry::Registry::new();
    registry = register_default_interceptors(registry, &mut media_engine)
        .map_err(|e| format!("interceptors: {e}"))?;

    let mut se = SettingEngine::default();
    se.set_ip_filter(Box::new(|ip: IpAddr| ip.is_ipv4()));
    se.set_network_types(vec![NetworkType::Udp4, NetworkType::Tcp4]);
    se.set_ice_multicast_dns_mode(MulticastDnsMode::QueryOnly);

    let api = APIBuilder::new()
        .with_setting_engine(se)
        .with_media_engine(media_engine)
        .with_interceptor_registry(registry)
        .build();

    let ice_cfg = ice_config();
    let ice_servers: Vec<RTCIceServer> = ice_cfg
        .servers
        .iter()
        .map(|s| RTCIceServer {
            urls: s.urls.clone(),
            username: s.username.clone().unwrap_or_default(),
            credential: s.credential.clone().unwrap_or_default(),
        })
        .collect();
    let ice_policy = match ice_cfg.transport_policy {
        IceTransportPolicy::All => RTCIceTransportPolicy::All,
        IceTransportPolicy::Relay => RTCIceTransportPolicy::Relay,
    };

    let pc = Arc::new(
        api.new_peer_connection(RTCConfiguration {
            ice_servers,
            ice_transport_policy: ice_policy,
            ..Default::default()
        })
        .await
        .map_err(|e| format!("peer connection: {e}"))?,
    );

    let video_track = Arc::new(TrackLocalStaticSample::new(
        RTCRtpCodecCapability {
            mime_type: match video_codec {
                VideoCodec::Vp8 => MIME_TYPE_VP8,
                VideoCodec::H264 => MIME_TYPE_H264,
            }
            .to_owned(),
            clock_rate: VP8_CLOCK_RATE,
            channels: 0,
            sdp_fmtp_line: match video_codec {
                VideoCodec::Vp8 => String::new(),
                VideoCodec::H264 => {
                    "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f"
                        .to_string()
                }
            },
            rtcp_feedback: vec![],
        },
        VIDEO_TRACK_ID.to_owned(),
        STREAM_ID.to_owned(),
    ));
    pc.add_track(Arc::clone(&video_track) as Arc<dyn TrackLocal + Send + Sync>)
        .await
        .map_err(|e| format!("add video track: {e}"))?;

    let audio_track = Arc::new(TrackLocalStaticSample::new(
        RTCRtpCodecCapability {
            mime_type: MIME_TYPE_OPUS.to_owned(),
            clock_rate: AUDIO_SAMPLE_RATE,
            channels: AUDIO_CHANNELS,
            sdp_fmtp_line: OPUS_SDP_FMTP.to_string(),
            rtcp_feedback: vec![],
        },
        AUDIO_TRACK_ID.to_owned(),
        STREAM_ID.to_owned(),
    ));
    pc.add_track(Arc::clone(&audio_track) as Arc<dyn TrackLocal + Send + Sync>)
        .await
        .map_err(|e| format!("add audio track: {e}"))?;

    Ok(InternalWebRtcStack {
        pc,
        video_track,
        audio_track,
    })
}

/// Build a minimal PeerConnection for ICE pre-warming (no tracks).
async fn build_ice_prewarm_pc() -> Result<RTCPeerConnection, String> {
    let mut media_engine = MediaEngine::default();
    media_engine
        .register_default_codecs()
        .map_err(|e| format!("register codecs: {e}"))?;

    let mut registry = webrtc::interceptor::registry::Registry::new();
    registry = register_default_interceptors(registry, &mut media_engine)
        .map_err(|e| format!("interceptors: {e}"))?;

    let mut se = SettingEngine::default();
    se.set_ip_filter(Box::new(|ip: IpAddr| ip.is_ipv4()));
    se.set_network_types(vec![NetworkType::Udp4, NetworkType::Tcp4]);
    se.set_ice_multicast_dns_mode(MulticastDnsMode::QueryOnly);

    let api = APIBuilder::new()
        .with_setting_engine(se)
        .with_media_engine(media_engine)
        .with_interceptor_registry(registry)
        .build();

    let ice_cfg = ice_config();
    let ice_servers: Vec<RTCIceServer> = ice_cfg
        .servers
        .iter()
        .map(|s| RTCIceServer {
            urls: s.urls.clone(),
            username: s.username.clone().unwrap_or_default(),
            credential: s.credential.clone().unwrap_or_default(),
        })
        .collect();

    Ok(api
        .new_peer_connection(RTCConfiguration {
            ice_servers,
            ..Default::default()
        })
        .await
        .map_err(|e| format!("peer connection: {e}"))?)
}

/// Set remote offer, create local answer, and wait for ICE gathering.
async fn exchange_sdp(
    pc: &RTCPeerConnection,
    offer_sdp: &str,
    done_rx: &mut tokio::sync::mpsc::Receiver<()>,
) -> Result<String, String> {
    let offer_desc = RTCSessionDescription::offer(offer_sdp.to_string())
        .map_err(|e| format!("parse offer: {e}"))?;
    pc.set_remote_description(offer_desc)
        .await
        .map_err(|e| format!("set remote: {e}"))?;
    let answer = pc
        .create_answer(None)
        .await
        .map_err(|e| format!("create answer: {e}"))?;
    pc.set_local_description(answer)
        .await
        .map_err(|e| format!("set local: {e}"))?;

    tokio::time::timeout(
        Duration::from_secs(ICE_GATHERING_TIMEOUT_SECS),
        done_rx.recv(),
    )
    .await
    .map_err(|_| "ICE gathering timed out".to_string())?
    .ok_or("ICE cancelled".to_string())?;

    tokio::time::sleep(Duration::from_secs(3)).await;

    let local_desc = pc.local_description().await.ok_or("no local desc")?;
    Ok(local_desc.sdp)
}

// ── Internal stack types ─────────────────────────────────────────────────────

pub(crate) struct InternalWebRtcStack {
    pub pc: Arc<RTCPeerConnection>,
    pub video_track: Arc<TrackLocalStaticSample>,
    pub audio_track: Arc<TrackLocalStaticSample>,
}

// ── Public API ───────────────────────────────────────────────────────────────

/// Result of building a WebRTC stack (without SDP exchange).
pub struct WebRtcStack {
    pub pc: Arc<RTCPeerConnection>,
    pub video_track: Arc<TrackLocalStaticSample>,
    pub audio_track: Arc<TrackLocalStaticSample>,
}

/// Build a WebRTC stack (PC + tracks) without DataChannel — we accept the
/// browser-created DC via ondatachannel instead of creating a negotiated one.
/// Used when starting a game session — the PC is created eagerly so it's
/// ready when the SDP offer arrives.
pub async fn build_session_pc() -> Result<WebRtcStack, String> {
    let InternalWebRtcStack {
        pc,
        video_track,
        audio_track,
    } = build_webrtc_stack(VideoCodec::H264).await?;

    // DC is created by browser as "diagnostics" (non-negotiated).
    // We receive it via ondatachannel — handled by the caller.

    Ok(WebRtcStack {
        pc,
        video_track,
        audio_track,
    })
}

/// Exchange SDP on an existing PeerConnection.
/// Takes a browser SDP offer, sets it as remote description, creates answer,
/// and waits for ICE gathering to complete. Returns the answer SDP.
pub async fn exchange_sdp_on_pc(pc: &RTCPeerConnection, offer_sdp: &str) -> Result<String, String> {
    let (done_tx, mut done_rx) = tokio::sync::mpsc::channel::<()>(1);
    pc.on_ice_candidate(Box::new({
        let done_tx = done_tx.clone();
        move |candidate: Option<webrtc::ice_transport::ice_candidate::RTCIceCandidate>| {
            let done_tx = done_tx.clone();
            Box::pin(async move {
                if candidate.is_none() {
                    let _ = done_tx.try_send(());
                }
            })
        }
    }));

    exchange_sdp(pc, offer_sdp, &mut done_rx).await
}

// ── ICE pre-warming ──────────────────────────────────────────────────────────

/// Pre-warm the ICE agent so the first real peer doesn't pay the full
/// ICE gathering penalty.
///
/// Creates a dummy PeerConnection, triggers ICE gathering, waits for
/// candidates, then holds the PC alive (via `std::mem::forget`).
/// TURN allocations and STUN bindings are cached by the kernel — subsequent
/// PCs gather in < 1s instead of 25-30s.
pub async fn prewarm_ice_agent() {
    tracing::info!("[PREWARM] starting ICE pre-warm...");
    let start = std::time::Instant::now();

    let pc = match build_ice_prewarm_pc().await {
        Ok(pc) => pc,
        Err(e) => {
            tracing::warn!("[PREWARM] failed to build PC: {e}");
            return;
        }
    };

    let (done_tx, mut done_rx) = tokio::sync::mpsc::channel::<()>(1);
    pc.on_ice_gathering_state_change(Box::new({
        let done_tx = done_tx.clone();
        move |state: RTCIceGathererState| {
            let done_tx = done_tx.clone();
            Box::pin(async move {
                if state == RTCIceGathererState::Complete {
                    let _ = done_tx.try_send(());
                }
            })
        }
    }));

    // Create a dummy offer to trigger ICE gathering
    let offer = match pc.create_offer(None).await {
        Ok(o) => o,
        Err(e) => {
            tracing::warn!("[PREWARM] create_offer failed: {e}");
            let _ = pc.close().await;
            return;
        }
    };
    if let Err(e) = pc.set_local_description(offer).await {
        tracing::warn!("[PREWARM] set_local_description failed: {e}");
        let _ = pc.close().await;
        return;
    }

    // Wait up to 15s for gathering (generous; usually 2-5s)
    match tokio::time::timeout(Duration::from_secs(15), done_rx.recv()).await {
        Ok(Some(())) => {
            tracing::info!(
                "[PREWARM] ICE gathering complete in {:?}",
                start.elapsed()
            );
        }
        Ok(None) => {
            tracing::warn!("[PREWARM] gathering channel closed");
        }
        Err(_) => {
            tracing::warn!("[PREWARM] ICE gathering timed out after 15s");
        }
    }

    // Do NOT close the pre-warm PC — closing it releases TURN allocations.
    // The first real peer would then have to re-allocate, defeating the purpose.
    // The PC stays alive for the server's lifetime; it gets cleaned up on exit.
    std::mem::forget(pc);
    tracing::info!(
        "[PREWARM] done in {:?} — TURN allocations held for first peer",
        start.elapsed()
    );
}
