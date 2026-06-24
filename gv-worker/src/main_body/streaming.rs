//! GStreamer-powered streaming loop: frame encoding, fan-out, and stats.
//!
//! Extracted from main_body/mod.rs.

use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::Duration;

use tokio_util::sync::CancellationToken;

use crate::config::{STATS_SEND_INTERVAL, VP8_CLOCK_RATE};
use crate::gst_video::GstVideoEncoder;

use super::AppState;

// ── Streaming context ───────────────────────────────────────────────────────

pub(super) struct StreamCtx {
    pub(super) cancel: CancellationToken,
    pub(super) app_state: Arc<AppState>,
}

// ── Encoder management ──────────────────────────────────────────────────────

/// Probe the first frame's resolution against the current encoder.
/// If they differ (e.g. genesis_plus_gx boot vs gameplay resolution),
/// rebuild the encoder. Returns Err if rebuild fails.
async fn probe_and_rebuild_encoder(
    state: &AppState,
    frame_width: u32,
    frame_height: u32,
    fps: f64,
) -> Result<(), String> {
    if frame_width == 0 || frame_height == 0 {
        return Ok(());
    }
    let enc_guard = state.video_enc.lock().await;
    if let Some(ref enc_arc) = *enc_guard {
        let enc = enc_arc.lock().await;
        let enc_w = enc.width();
        let enc_h = enc.height();
        let sf = enc.scale_factor();
        let enc_core_w = enc_w.checked_div(sf).unwrap_or(enc_w);
        let enc_core_h = enc_h.checked_div(sf).unwrap_or(enc_h);
        if frame_width != enc_core_w || frame_height != enc_core_h {
            tracing::info!(
                "[STREAM] Resolution probe: encoder {ecw}×{ech}, actual {aw}×{ah} — rebuilding",
                ecw = enc_core_w, ech = enc_core_h, aw = frame_width, ah = frame_height,
            );
            drop(enc);
            drop(enc_guard);
            let new_enc = GstVideoEncoder::new(frame_width, frame_height, fps)
                .map_err(|e| format!("encoder rebuild failed: {e}"))?;
            *state.video_enc.lock().await =
                Some(Arc::new(tokio::sync::Mutex::new(new_enc)));
        }
    }
    Ok(())
}


async fn push_video_frame(
    state: &AppState,
    pixels: &[u8],
    w: u32,
    h: u32,
    frame_num: u64,
) -> Result<(), String> {
    let enc_guard = state.video_enc.lock().await;
    if let Some(ref enc_arc) = *enc_guard {
        enc_arc.lock().await.push(pixels, (w, h), frame_num)
            .map_err(|e| format!("video push error at frame {frame_num}: {e}"))?;
    }
    Ok(())
}

async fn push_audio(
    state: &AppState,
    audio_data: &[i16],
    audio_acc: &mut Vec<i16>,
) {
    let aenc_guard = state.audio_enc.lock().await;
    if let Some(ref aenc_arc) = *aenc_guard {
        if let Some(ref mut enc) = *aenc_arc.lock().await {
            let mut buf = std::mem::take(audio_acc);
            buf.extend_from_slice(audio_data);
            let chunk = (enc.sample_rate() as f64 * 0.02).round() as usize * enc.channels() as usize;
            while buf.len() >= chunk {
                let rest = buf.split_off(chunk);
                enc.push(&buf);
                buf = rest;
            }
            *audio_acc = buf;
        }
    }
}

async fn fan_out_video(
    state: &AppState,
    frame_num: u64,
    fps: f64,
    frame_interval: Duration,
) {
    use webrtc::media::Sample;
    loop {
        let sample = {
            let enc_guard = state.video_enc.lock().await;
            match enc_guard.as_ref() {
                Some(enc_arc) => enc_arc.lock().await.try_pull().map(|data| Sample {
                        data: data.into(),
                        duration: frame_interval,
                        packet_timestamp: frame_num
                            .wrapping_sub(1)
                            .saturating_mul((VP8_CLOCK_RATE as f64 / fps.max(1.0)).round() as u64)
                            as u32,
                        ..Default::default()
                    }),
                None => None,
            }
        };

        match sample {
            Some(ref sample) => {
                let mut dead: Vec<String> = Vec::new();
                {
                    let peers = state.peers.lock().await;
                    for (peer_id, peer) in peers.iter() {
                        if let Err(e) = peer.video_track.write_sample(sample).await {
                            tracing::warn!(
                                "[STREAM] peer {:.8} video write error: {e}",
                                peer_id
                            );
                            dead.push(peer_id.clone());
                        }
                    }
                }
                for id in &dead {
                    state.peers.lock().await.remove(id);
                    tracing::info!("[STREAM] removed dead peer {:.8}", id);
                }
                state.frames_encoded.fetch_add(1, Ordering::Relaxed);
            }
            None => break,
        }
    }
}

async fn fan_out_audio(
    state: &AppState,
    mut audio_ts: u32,
    audio_write_errs: &mut u64,
) -> u32 {
    use webrtc::media::Sample;
    let aenc_guard = state.audio_enc.lock().await;
    if let Some(ref aenc_arc) = *aenc_guard {
        loop {
            let opus_data = {
                let guard = aenc_arc.lock().await;
                match *guard {
                    Some(ref enc) => enc.try_pull(),
                    None => None,
                }
            };
            match opus_data {
                Some(opus_data) => {
                    let sample = Sample {
                        data: opus_data.into(),
                        duration: Duration::from_millis(20),
                        packet_timestamp: audio_ts,
                        ..Default::default()
                    };
                    audio_ts = audio_ts.wrapping_add(960);
                    let peers = state.peers.lock().await;
                    for (peer_id, peer) in peers.iter() {
                        if let Err(e) = peer.audio_track.write_sample(&sample).await {
                            tracing::warn!(
                                "[STREAM] peer {:.8} audio write error: {e}",
                                peer_id
                            );
                            *audio_write_errs = audio_write_errs.wrapping_add(1);
                        }
                    }
                }
                None => break,
            }
        }
    }
    audio_ts
}

async fn send_stats(
    state: &AppState,
    frame_num: u64,
    audio_write_errs: u64,
    start_instant: std::time::Instant,
) {
    if !frame_num.is_multiple_of(STATS_SEND_INTERVAL) {
        return;
    }
    let (pushed, pulled) = {
        let enc_guard = state.video_enc.lock().await;
        match enc_guard.as_ref() {
            Some(enc) => enc.lock().await.stats(),
            None => (0, 0),
        }
    };
    if let Ok(stats) = serde_json::to_string(&serde_json::json!({
        "type": "stats",
        "frame": frame_num,
        "pipeline": {
            "video_pushed": pushed,
            "video_pulled": pulled,
            "video_pending": pushed.saturating_sub(pulled),
            "audio_write_errs": audio_write_errs,
            "uptime_sec": start_instant.elapsed().as_secs()
        }
    })) {
        let peers = state.peers.lock().await;
        for (_, peer) in peers.iter() {
            if let Some(dc) = peer.dc_stream.lock().await.as_ref() {
                let _ = dc.send_text(&stats).await;
            }
        }
    }
}
pub(super) async fn stream_frames(ctx: StreamCtx) {
    

    let fps = *ctx.app_state.core_fps.lock().await;
    let frame_interval = Duration::from_secs_f64(1.0 / fps.max(1.0));
    let mut frame_num: u64 = 0;
    let mut audio_ts: u32 = 0;
    let mut audio_write_errs: u64 = 0;
    let mut audio_acc: Vec<i16> = Vec::new();
    let start_instant = std::time::Instant::now();

    let mut tick = tokio::time::interval(frame_interval);
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

    // Some cores (genesis_plus_gx) boot at one resolution then switch
    // to a different gameplay resolution on the first few frames.
    // Probe the first frame and rebuild the encoder if needed.
    let mut resolution_probed = false;

    tracing::info!("[STREAM] Starting GStreamer frame loop @ {:.1}fps", fps);

    loop {
        tokio::select! {
            _ = ctx.cancel.cancelled() => {
                tracing::info!("[STREAM] Cancelled");
                break;
            }
            _ = tick.tick() => {
                // ── Drain core frames ─────────────────────────
                let mut video_data: Option<(Vec<u8>, u32, u32)> = None;
                let mut audio_data: Vec<i16> = Vec::new();

                {
                    let frame_rx_guard = ctx.app_state.core_frame_rx.lock().await;
                    if let Some(ref rx) = *frame_rx_guard {
                        let mut latest = None;
                        while let Ok(f) = rx.try_recv() {
                            latest = Some(f);
                        }
                        match latest {
                            Some(f) if f.width == 0 => {
                                tracing::error!("[STREAM] Core sentinel — died");
                                break;
                            }
                            Some(f) => {
                                // ── Resolution probe (first frame only) ──
                                if !resolution_probed {
                                    resolution_probed = true;
                                    if let Err(e) = probe_and_rebuild_encoder(
                                        &ctx.app_state,
                                        f.width,
                                        f.height,
                                        fps,
                                    )
                                    .await
                                    {
                                        tracing::error!("[STREAM] {e}");
                                        break;
                                    }
                                }
                                video_data = Some((f.pixels, f.width, f.height));
                                audio_data = f.audio;
                            }
                            None => {
                                continue;
                            }
                        }
                    }
                }

                frame_num = frame_num.wrapping_add(1);

                // ── Push to GStreamer ─────────────────────────
                if let Some((ref pixels, w, h)) = video_data {
                    if let Err(e) = push_video_frame(&ctx.app_state, pixels, w, h, frame_num).await {
                        tracing::error!("[STREAM] {e}");
                        break;
                    }
                }

                // ── Accumulate and push audio in 20ms chunks ──
                if !audio_data.is_empty() {
                    push_audio(&ctx.app_state, &audio_data, &mut audio_acc).await;
                }

                // ── Drain encoded video → fan-out to ALL peers ──
                fan_out_video(&ctx.app_state, frame_num, fps, frame_interval).await;

                // ── Drain encoded audio → fan-out to ALL peers ──
                audio_ts = fan_out_audio(&ctx.app_state, audio_ts, &mut audio_write_errs).await;

                // ── Stats to all peer DataChannels ──
                send_stats(
                    &ctx.app_state,
                    frame_num,
                    audio_write_errs,
                    start_instant,
                )
                .await;
            }
        }
    }

    tracing::info!("[STREAM] Loop exited");

    // Close all peer connections
    {
        let mut peers = ctx.app_state.peers.lock().await;
        for (_, peer) in peers.drain() {
            let _ = peer.pc.close().await;
        }
    }

    // Self-destruct timer
    {
        let exit = ctx.app_state.exit_signal.clone();
        let handle = tokio::spawn(async move {
            tokio::time::sleep(Duration::from_secs(crate::config::WORKER_IDLE_TIMEOUT_SECS)).await;
            tracing::warn!("[SELF-DESTRUCT] idle timeout — shutting down");
            exit.cancel();
        });
        *ctx.app_state.destruct_timer.lock().await = Some(handle);
    }
}
