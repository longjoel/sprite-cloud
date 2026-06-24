//! WebRTC stack, SDP handshake, encoder setup, and peer lifecycle management.
//!
//! Extracted from main_body/mod.rs.

use std::net::IpAddr;
use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::Duration;

use tokio_util::sync::CancellationToken;

use webrtc::api::interceptor_registry::register_default_interceptors;
use webrtc::api::media_engine::{MediaEngine, MIME_TYPE_H264, MIME_TYPE_OPUS, MIME_TYPE_VP8};
use webrtc::api::setting_engine::SettingEngine;
use webrtc::api::APIBuilder;
use webrtc::ice_transport::ice_server::RTCIceServer;
use webrtc::ice::network_type::NetworkType;
use webrtc::ice::mdns::MulticastDnsMode;
use webrtc::peer_connection::configuration::RTCConfiguration;
use webrtc::peer_connection::peer_connection_state::RTCPeerConnectionState;
use webrtc::peer_connection::policy::ice_transport_policy::RTCIceTransportPolicy;
use webrtc::peer_connection::sdp::session_description::RTCSessionDescription;
use webrtc::peer_connection::RTCPeerConnection;
use webrtc::rtp_transceiver::rtp_codec::RTCRtpCodecCapability;
use webrtc::track::track_local::track_local_static_sample::TrackLocalStaticSample;
use webrtc::track::track_local::TrackLocal;

use crate::config::{
    self, ice_config, AUDIO_CHANNELS, AUDIO_SAMPLE_RATE, AUDIO_TRACK_ID,
    DC_RECEIVE_TIMEOUT_SECS, ICE_GATHERING_TIMEOUT_SECS, OPUS_SDP_FMTP, STREAM_ID,
    VIDEO_TRACK_ID, VP8_CLOCK_RATE,
};
use crate::core_bridge::{CoreCommand, CoreFrame, CoreResponse};
use crate::gst_audio::GstAudioEncoder;
use crate::gst_video::{GstVideoEncoder, VideoCodec};

use super::{
    AppState, PeerState, PeerLifecycle, PeerRole, SdpAnswer, broadcast_room_state,
};
use super::streaming::StreamCtx;
use super::input::map_key_to_joypad;

// ── SDP helpers ──────────────────────────────────────────────────────────────

fn sdp_offer_supports_h264(offer_sdp: &str) -> bool {
    offer_sdp
        .lines()
        .any(|line| line.to_ascii_lowercase().contains("h264/90000"))
}

fn create_video_encoder(
    core_width: u32,
    core_height: u32,
    core_fps: f64,
    offer_sdp: &str,
) -> Result<GstVideoEncoder, String> {
    match config::gst_video_codec() {
        config::VideoCodecPreference::Vp8 => {
            GstVideoEncoder::new_with_codec(core_width, core_height, core_fps, VideoCodec::Vp8)
        }
        config::VideoCodecPreference::H264 => {
            if !sdp_offer_supports_h264(offer_sdp) {
                return Err(
                    "GV_GST_VIDEO_CODEC=h264 but browser offer does not include H.264".into(),
                );
            }
            GstVideoEncoder::new_with_codec(core_width, core_height, core_fps, VideoCodec::H264)
        }
        config::VideoCodecPreference::Auto => {
            if sdp_offer_supports_h264(offer_sdp) {
                match GstVideoEncoder::new_with_codec(
                    core_width,
                    core_height,
                    core_fps,
                    VideoCodec::H264,
                ) {
                    Ok(enc) => return Ok(enc),
                    Err(e) => tracing::warn!(
                        "[GST-video] H.264 auto setup failed, falling back to VP8: {e}"
                    ),
                }
            }
            GstVideoEncoder::new_with_codec(core_width, core_height, core_fps, VideoCodec::Vp8)
        }
    }
}

// ── Handshake pipeline: phase functions ─────────────────────────────────────

/// Returned by load_core() — named fields instead of a 7-tuple.
struct CoreHandle {
    width: u32,
    height: u32,
    fps: f64,
    cmd_tx: Option<std::sync::mpsc::SyncSender<CoreCommand>>,
    frame_rx: Option<std::sync::mpsc::Receiver<CoreFrame>>,
    response_rx: Option<std::sync::mpsc::Receiver<CoreResponse>>,
    sample_rate: Option<f64>,
    audio_channels: usize,
}

async fn load_core(state: &AppState) -> Result<CoreHandle, String> {
    let _core_guard = state.core_spawning.lock().await;
    match crate::core_bridge::spawn_core_thread() {
        Some(handle) => {
            tracing::info!(
                "[STREAM] Core: {}×{} @ {:.1}fps {:.0}Hz",
                handle.width, handle.height, handle.fps, handle.sample_rate
            );
            state.core_loaded.store(true, Ordering::Relaxed);
            Ok(CoreHandle {
                width: handle.width,
                height: handle.height,
                fps: handle.fps,
                cmd_tx: Some(handle.cmd_tx),
                frame_rx: Some(handle.frame_rx),
                response_rx: Some(handle.response_rx),
                sample_rate: Some(handle.sample_rate),
                audio_channels: handle.audio_channels as usize,
            })
        }
        None => {
            let msg = "no libretro core available — the ROM may be corrupt or unsupported".to_string();
            *state.core_error.lock().await = Some(msg.clone());
            Err(msg)
        }
    }
}

struct EncoderSet {
    video: Arc<tokio::sync::Mutex<GstVideoEncoder>>,
    audio: Arc<tokio::sync::Mutex<Option<GstAudioEncoder>>>,
    video_codec: VideoCodec,
}

fn setup_encoders(core: &CoreHandle, offer_sdp: &str) -> Result<EncoderSet, String> {
    let video_encoder = create_video_encoder(core.width, core.height, core.fps, offer_sdp)
        .map_err(|e| format!("video encoder: {e}"))?;
    let selected = video_encoder.codec();
    let venc = Arc::new(tokio::sync::Mutex::new(video_encoder));

    let aenc: Arc<tokio::sync::Mutex<Option<GstAudioEncoder>>> =
        Arc::new(tokio::sync::Mutex::new(match core.sample_rate {
            Some(rate) => match GstAudioEncoder::new(rate, core.audio_channels as u16) {
                Ok(enc) => Some(enc),
                Err(e) => {
                    tracing::error!("[AUDIO] encoder failed: {e} — audio disabled");
                    None
                }
            },
            None => None,
        }));

    Ok(EncoderSet {
        video: venc,
        audio: aenc,
        video_codec: selected,
    })
}

async fn reuse_encoders(state: &AppState) -> Result<EncoderSet, String> {
    let venc = state.video_enc.lock().await.clone()
        .ok_or("video encoder not available")?;
    let aenc = state.audio_enc.lock().await.clone()
        .ok_or("audio encoder not available")?;
    let _fps = *state.core_fps.lock().await;
    let selected = venc.lock().await.codec();

    Ok(EncoderSet {
        video: venc,
        audio: aenc,
        video_codec: selected,
    })
}

// ── WebRTC stack helpers ────────────────────────────────────────────────────

struct WebRtcStack {
    pc: Arc<RTCPeerConnection>,
    video_track: Arc<TrackLocalStaticSample>,
    audio_track: Arc<TrackLocalStaticSample>,
}

async fn build_webrtc_stack(video_codec: VideoCodec) -> Result<WebRtcStack, String> {
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
            ..Default::default()
        })
        .collect();
    let ice_policy = match ice_cfg.transport_policy {
        config::IceTransportPolicy::All => RTCIceTransportPolicy::All,
        config::IceTransportPolicy::Relay => RTCIceTransportPolicy::Relay,
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
                VideoCodec::H264 =>
                    "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f".to_string(),
            },
            rtcp_feedback: vec![],
        },
        VIDEO_TRACK_ID.to_owned(),
        STREAM_ID.to_owned(),
    ));
    pc.add_track(Arc::clone(&video_track) as Arc<dyn TrackLocal + Send + Sync>)
        .await.map_err(|e| format!("add video track: {e}"))?;

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
        .await.map_err(|e| format!("add audio track: {e}"))?;

    Ok(WebRtcStack { pc, video_track, audio_track })
}

async fn exchange_sdp(
    pc: &RTCPeerConnection,
    offer_sdp: &str,
    done_rx: &mut tokio::sync::mpsc::Receiver<()>,
) -> Result<SdpAnswer, String> {
    let offer_desc = RTCSessionDescription::offer(offer_sdp.to_string())
        .map_err(|e| format!("parse offer: {e}"))?;
    pc.set_remote_description(offer_desc)
        .await.map_err(|e| format!("set remote: {e}"))?;
    let answer = pc.create_answer(None)
        .await.map_err(|e| format!("create answer: {e}"))?;
    pc.set_local_description(answer)
        .await.map_err(|e| format!("set local: {e}"))?;

    tokio::time::timeout(
        Duration::from_secs(ICE_GATHERING_TIMEOUT_SECS),
        done_rx.recv(),
    )
    .await
    .map_err(|_| "ICE gathering timed out".to_string())?
    .ok_or("ICE cancelled".to_string())?;

    tokio::time::sleep(Duration::from_secs(3)).await;

    let local_desc = pc.local_description().await.ok_or("no local desc")?;
    Ok(SdpAnswer { sdp: local_desc.sdp })
}


fn spawn_dc_handler(
    state: Arc<AppState>,
    peer_token: String,
    peer_role: PeerRole,
    peer_seat: u32,
    core_cmd_tx: Option<std::sync::mpsc::SyncSender<CoreCommand>>,
    mut dc_rx: tokio::sync::mpsc::Receiver<Arc<webrtc::data_channel::RTCDataChannel>>,
) -> Arc<tokio::sync::Mutex<Option<Arc<webrtc::data_channel::RTCDataChannel>>>> {
    // DataChannel auth — lifecycle-driven
    let dc_stream: Arc<tokio::sync::Mutex<Option<Arc<webrtc::data_channel::RTCDataChannel>>>> =
        Arc::new(tokio::sync::Mutex::new(None));
    let dc_stream_for_spawn = dc_stream.clone();
    let dc_state = Arc::clone(&state);
    let dc_peer_id = peer_token;
    let dc_core_cmd = core_cmd_tx;
    let dc_peer_role = peer_role;
    let dc_peer_seat = peer_seat;

    tokio::spawn(async move {
        let dc = match tokio::time::timeout(
            Duration::from_secs(DC_RECEIVE_TIMEOUT_SECS),
            dc_rx.recv(),
        )
        .await
        {
            Ok(Some(dc)) => dc,
            _ => {
                tracing::info!("[DC] no DataChannel from browser");
                // Transition to Disconnected — no DC means dead connection
                if let Some(peer) = dc_state.peers.lock().await.get_mut(&dc_peer_id) {
                    peer.lifecycle = PeerLifecycle::Disconnected;
                }
                return;
            }
        };
        *dc_stream_for_spawn.lock().await = Some(dc.clone());

        // Transition: Negotiating → Active (no DC auth — SDP already validated)
        {
            let mut peers = dc_state.peers.lock().await;
            if let Some(peer) = peers.get_mut(&dc_peer_id) {
                peer.lifecycle = PeerLifecycle::Active {
                    role: dc_peer_role,
                    seat: dc_peer_seat,
                };
            }
        }

        dc.on_message(Box::new({
            let dc_cmd = dc.clone();
            let dc_msg_state = Arc::clone(&dc_state);
            let dc_msg_peer_id = dc_peer_id.clone();
            move |msg| {
                let dc = dc_cmd.clone();
                let core_tx = dc_core_cmd.clone();
                let seat = dc_peer_seat;
                let state = Arc::clone(&dc_msg_state);
                let pid = dc_msg_peer_id.clone();
                Box::pin(async move {
                    // Binary input (3-byte RetroArch format) — SERVER-ASSIGNED seat
                    if msg.data.len() == 3 {
                        let allowed = {
                            let peers = state.peers.lock().await;
                            peers.get(&pid)
                                .map(|p| matches!(p.lifecycle, PeerLifecycle::Active { .. }))
                                .unwrap_or(false)
                        };
                        if !allowed {
                            return;
                        }
                        let input_state = u16::from_le_bytes([msg.data[1], msg.data[2]]);
                        if let Some(ref tx) = core_tx {
                            let _ = tx.try_send(CoreCommand::SetInput {
                                port: seat,
                                state: input_state,
                            });
                        }
                        return;
                    }

                    let text = String::from_utf8_lossy(&msg.data).trim().to_string();

                    // Plain ping
                    if text == "ping" {
                        let now = std::time::SystemTime::now()
                            .duration_since(std::time::UNIX_EPOCH)
                            .unwrap_or_default()
                            .as_millis();
                        let resp = serde_json::json!({"type":"pong","server_ts_ms":now});
                        let _ = dc.send_text(&resp.to_string()).await;
                        return;
                    }

                    let cmd: serde_json::Value = match serde_json::from_str(&text) {
                        Ok(v) => v,
                        Err(_) => return,
                    };
                    let cmd_type = cmd.get("cmd").and_then(|v| v.as_str()).unwrap_or("");

                    // Auth message — no-op. The SDP handshake already validated
                    // this peer. The invite link is the auth. If you made it
                    // here, you get audio/video.
                    if cmd_type == "auth" {
                        return;
                    }

                    // JSON ping
                    if cmd_type == "ping" {
                        let seq = cmd.get("seq").and_then(|v| v.as_u64()).unwrap_or(0);
                        let now = std::time::SystemTime::now()
                            .duration_since(std::time::UNIX_EPOCH)
                            .unwrap_or_default()
                            .as_millis();
                        let resp =
                            serde_json::json!({"type":"pong","seq":seq,"server_ts_ms":now});
                        let _ = dc.send_text(&resp.to_string()).await;
                        return;
                    }

                    // Role-gated: check lifecycle for permissions
                    let (is_host, can_input) = {
                        let peers = state.peers.lock().await;
                        match peers.get(&pid).map(|p| &p.lifecycle) {
                            Some(PeerLifecycle::Active { role, .. }) => {
                                (*role == PeerRole::Host, *role == PeerRole::Host || *role == PeerRole::Player)
                            }
                            _ => (false, false),
                        }
                    };
                    if !can_input {
                        return;
                    }
                    match cmd_type {
                        "input" => {
                            if let (Some(key), Some(pressed)) = (
                                cmd.get("key").and_then(|v| v.as_str()),
                                cmd.get("pressed").and_then(|v| v.as_bool()),
                            ) {
                                if let Some(button) = map_key_to_joypad(key) {
                                    let _ = core_tx.as_ref().map(|tx| {
                                        tx.try_send(CoreCommand::SetJoypad {
                                            port: seat,
                                            button,
                                            pressed,
                                        })
                                    });
                                }
                            }
                        }
                        "force_keyframe" if is_host => {
                            tracing::info!("[DC] force_keyframe requested");
                        }
                        "save_state" | "load_state" if is_host => {
                            if let Some(slot) = cmd.get("slot").and_then(|v| v.as_u64()) {
                                let slot = slot.min(9) as u8;
                                if slot >= 1 {
                                    let cmd = if cmd_type == "save_state" {
                                        CoreCommand::SaveState { slot }
                                    } else {
                                        CoreCommand::LoadState { slot }
                                    };
                                    let _ = core_tx.as_ref().map(|tx| tx.try_send(cmd));
                                }
                            }
                        }
                        "reset" if is_host => {
                            tracing::info!("[DC] reset requested");
                            let _ = core_tx.as_ref().map(|tx| tx.try_send(CoreCommand::Reset));
                        }
                        "disk_eject" if is_host => {
                            tracing::info!("[DC] disk_eject requested");
                            let _ =
                                core_tx.as_ref().map(|tx| tx.try_send(CoreCommand::DiskEject));
                        }
                        "disk_insert" if is_host => {
                            let index =
                                cmd.get("index").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
                            tracing::info!("[DC] disk_insert index={}", index);
                            let _ = core_tx
                                .as_ref()
                                .map(|tx| tx.try_send(CoreCommand::DiskInsert { index }));
                        }
                        _ => {}
                    }
                })
            }
        }));
    });

    dc_stream
}
// ── WebRTC handshake ────────────────────────────────────────────────────────

pub(crate) async fn do_webrtc_handshake(
    state: Arc<AppState>,
    offer_sdp: &str,
    peer_token: &str,
    peer_role: PeerRole,
    peer_seat: u32,
) -> Result<SdpAnswer, String> {
    // Check if this is the first peer (needs to load core + spawn stream)
    let is_first_peer = !state.core_loaded.load(Ordering::Relaxed);

    let (core_cmd_tx, encoders) = if is_first_peer {
        let core = load_core(&state).await?;
        let encoders = setup_encoders(&core, offer_sdp)?;
        // Store in AppState for subsequent peers
        *state.core_width.lock().await = core.width;
        *state.core_height.lock().await = core.height;
        *state.core_fps.lock().await = core.fps;
        *state.video_enc.lock().await = Some(encoders.video.clone());
        *state.audio_enc.lock().await = Some(encoders.audio.clone());
        *state.core_cmd_tx.lock().await = core.cmd_tx.clone();
        *state.core_frame_rx.lock().await = core.frame_rx;
        *state.core_response_rx.lock().await = core.response_rx;

        (core.cmd_tx, encoders)
    } else {
        let encoders = reuse_encoders(&state).await?;
        let cmd_tx = state.core_cmd_tx.lock().await.clone();
        (cmd_tx, encoders)
    };

    // Reconnect semantics: one live PeerConnection per peer_token.
    // Browser retries create a fresh ICE ufrag; keeping the old PC alive makes
    // webrtc-rs reject the new checks as ErrMismatchUsername against the old
    // remote ufrag. Close/sweep stale attempts before accepting this offer.
    {
        let mut peers = state.peers.lock().await;
        // Close existing PC for this token (reconnect: close old, accept new)
        if let Some(existing) = peers.get(peer_token) {
            let _ = existing.pc.close().await;
        }
        // Sweep Disconnected tombstones (no live PC to close)
        peers.retain(|_, p| !matches!(p.lifecycle, PeerLifecycle::Disconnected));
    }

    // ── Build WebRTC stack + exchange SDP ──
    let WebRtcStack { pc, video_track, audio_track } =
        build_webrtc_stack(encoders.video_codec).await?;

    // ICE gathering callback (must be set before exchange_sdp)
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

    // DataChannel receive
    let (dc_tx, dc_rx) =
        tokio::sync::mpsc::channel::<Arc<webrtc::data_channel::RTCDataChannel>>(1);
    pc.on_data_channel(Box::new(
        move |d: Arc<webrtc::data_channel::RTCDataChannel>| {
            let tx = dc_tx.clone();
            Box::pin(async move {
                let _ = tx.send(d).await;
            })
        },
    ));

    let answer_sdp = exchange_sdp(&pc, offer_sdp, &mut done_rx).await?;

    // DataChannel auth — lifecycle-driven
    let dc_stream = spawn_dc_handler(
        Arc::clone(&state),
        peer_token.to_string(),
        peer_role,
        peer_seat,
        core_cmd_tx,
        dc_rx,
    );
    // Core response drain (first peer only — response_rx is single-consumer)
    if is_first_peer {
        if let Some(core_response_rx) = state.core_response_rx.lock().await.take() {
            let dc_for_resp = dc_stream.clone();
            tokio::spawn(async move {
                while let Ok(resp) = core_response_rx.recv() {
                    let json = match resp {
                        crate::core_bridge::CoreResponse::SaveStateResult { slot, ok, data } => {
                            serde_json::json!({"type":"save_state_result","slot":slot,"ok":ok,"bytes":data.len()})
                        }
                        crate::core_bridge::CoreResponse::LoadStateResult { slot, ok } => {
                            serde_json::json!({"type":"load_state_result","slot":slot,"ok":ok})
                        }
                    };
                    if let Some(dc) = dc_for_resp.lock().await.as_ref() {
                        let _ = dc.send_text(&json.to_string()).await;
                    }
                }
            });
        }
    }

    // Store peer in registry — use ACTUAL token as key (one live PC per token).
    // Stale same-token peers are closed above before the new PC is created.
    let peer_id = peer_token.to_string();
    state.peers.lock().await.insert(
        peer_id.clone(),
        PeerState {
            pc: Arc::clone(&pc),
            lifecycle: PeerLifecycle::Negotiating,
            dc_stream: dc_stream.clone(),
            video_track: Arc::clone(&video_track),
            audio_track: Arc::clone(&audio_track),
        },
    );
    tracing::info!(
        "[PEER] {:.8} registered (seat={}, role={:?})",
        peer_id,
        peer_seat,
        peer_role
    );

    // Broadcast updated room state to all connected peers
    broadcast_room_state(&state).await;

    // Disconnect detection — tombstone as Disconnected (don't remove — reconnect semantics)
    let disconnect_state = Arc::clone(&state);
    let disconnect_peer_id = peer_id.clone();
    pc.on_peer_connection_state_change(Box::new(move |s: RTCPeerConnectionState| {
        let state = Arc::clone(&disconnect_state);
        let pid = disconnect_peer_id.clone();
        Box::pin(async move {
            match s {
                RTCPeerConnectionState::Failed | RTCPeerConnectionState::Closed => {
                    tracing::info!(
                        "[PEER] {:.8} disconnected ({:?})",
                        &pid[..8.min(pid.len())],
                        s
                    );
                    if let Some(peer) = state.peers.lock().await.get_mut(&pid) {
                        peer.lifecycle = PeerLifecycle::Disconnected;
                    }
                    broadcast_room_state(&state).await;
                }
                _ => {}
            }
        })
    }));

    // Spawn streaming loop on first peer only
    if is_first_peer {
        let stream_cancel = CancellationToken::new();
        let stream_ctx = StreamCtx {
            cancel: stream_cancel.clone(),
            app_state: Arc::clone(&state),
        };

        let handle = tokio::spawn(async move {
            super::streaming::stream_frames(stream_ctx).await;
        });

        {
            *state.stream_handle.lock().await = Some(handle);
            *state.cancel.lock().await = stream_cancel;
        }
    }

    // Clear destruct timer (stream is active)
    {
        let mut timer = state.destruct_timer.lock().await;
        if let Some(h) = timer.take() {
            h.abort();
        }
    }

    Ok(answer_sdp)
}
