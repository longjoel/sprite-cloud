//! GStreamer-powered streaming loop: frame encoding and shared-memory output.
//!
//! Extracted from main_body/mod.rs.

use std::sync::Arc;
use std::time::Duration;

use tokio_util::sync::CancellationToken;

use gv_shm::{ShmRing, frame_type};

use crate::gst_audio::GstAudioEncoder;
use crate::gst_video::{GstVideoEncoder, VideoCodec};

use super::AppState;

// ── Streaming context ───────────────────────────────────────────────────────

pub struct StreamCtx {
    pub cancel: CancellationToken,
    pub app_state: Arc<AppState>,
    pub shm: Arc<ShmRing>,
}

// ── Test pattern generator (loading state before core is ready) ─────────────

/// Generate a solid-color test frame at the given dimensions.
/// Uses the GV mahogany background (#1a1410) so the loading screen
/// matches the site aesthetic.
fn generate_test_frame(width: u32, height: u32) -> Vec<u8> {
    let pixel_count = (width * height) as usize;
    let mut pixels = Vec::with_capacity(pixel_count * 3);
    // Mahogany dark: RGB(26, 20, 16)
    for _ in 0..pixel_count {
        pixels.push(26);  // R
        pixels.push(20);  // G
        pixels.push(16);  // B
    }
    pixels
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
    let needs_create = enc_guard.is_none();
    let needs_rebuild = if let Some(ref enc_arc) = *enc_guard {
        let enc = enc_arc.lock().await;
        let enc_w = enc.width();
        let enc_h = enc.height();
        let sf = enc.scale_factor();
        let enc_core_w = enc_w.checked_div(sf).unwrap_or(enc_w);
        let enc_core_h = enc_h.checked_div(sf).unwrap_or(enc_h);
        frame_width != enc_core_w || frame_height != enc_core_h
    } else {
        false
    };

    if needs_create || needs_rebuild {
        if needs_rebuild {
            tracing::info!(
                "[STREAM] Resolution probe: actual {aw}×{ah} — rebuilding encoder",
                aw = frame_width, ah = frame_height,
            );
        } else {
            tracing::info!(
                "[STREAM] Creating video encoder: {w}×{h} @ {fps:.1}fps",
                w = frame_width, h = frame_height, fps = fps
            );
        }
        drop(enc_guard);
        let new_enc = GstVideoEncoder::new_with_codec(frame_width, frame_height, fps, VideoCodec::H264)
            .map_err(|e| format!("encoder create/rebuild failed: {e}"))?;
        *state.video_enc.lock().await =
            Some(Arc::new(tokio::sync::Mutex::new(new_enc)));

        // Also create audio encoder on first video encoder init
        if needs_create {
            let sample_rate: f64 = 48000.0;
            if sample_rate > 0.0 {
                match GstAudioEncoder::new(sample_rate, 2) {
                    Ok(aenc) => {
                        *state.audio_enc.lock().await =
                            Some(Arc::new(tokio::sync::Mutex::new(Some(aenc))));
                        tracing::info!(
                            "[STREAM] Audio encoder created: {:.0}Hz {}ch",
                            sample_rate, 2
                        );
                    }
                    Err(e) => {
                        tracing::warn!("[STREAM] Audio encoder creation failed: {e}");
                    }
                }
            }
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

/// Drain encoded H.264 video from the GStreamer encoder and write to shared memory.
async fn drain_to_shm_video(
    state: &AppState,
    shm: &ShmRing,
    timestamp_us: u32,
) {
    loop {
        let data = {
            let enc_guard = state.video_enc.lock().await;
            match enc_guard.as_ref() {
                Some(enc_arc) => enc_arc.lock().await.try_pull(),
                None => None,
            }
        };

        match data {
            Some(data) => {
                if let Err(e) = shm.write_frame(frame_type::VIDEO, &data, timestamp_us) {
                    if e.kind() != std::io::ErrorKind::WouldBlock {
                        tracing::warn!("[STREAM] shm video write error: {e}");
                    }
                }
            }
            None => break,
        }
    }
}

/// Drain encoded Opus audio from the GStreamer encoder and write to shared memory.
async fn drain_to_shm_audio(
    state: &AppState,
    shm: &ShmRing,
    mut audio_ts: u32,
    audio_write_errs: &mut u64,
) -> u32 {
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
                    if let Err(e) = shm.write_frame(frame_type::AUDIO, &opus_data, audio_ts) {
                        if e.kind() != std::io::ErrorKind::WouldBlock {
                            tracing::warn!("[STREAM] shm audio write error: {e}");
                            *audio_write_errs = audio_write_errs.wrapping_add(1);
                        }
                    }
                    audio_ts = audio_ts.wrapping_add(960);
                }
                None => break,
            }
        }
    }
    audio_ts
}

pub async fn stream_frames(ctx: StreamCtx) {
    

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
                // ── Drain core frames (or generate test pattern) ─────────
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
                                // No core frame available — generate test pattern if core is loading
                                let core_loading = ctx.app_state.core_loading.load(std::sync::atomic::Ordering::Relaxed);
                                let core_loaded = ctx.app_state.core_loaded.load(std::sync::atomic::Ordering::Relaxed);
                                if core_loading || !core_loaded {
                                    let w = *ctx.app_state.core_width.lock().await;
                                    let h = *ctx.app_state.core_height.lock().await;
                                    if w > 0 && h > 0 {
                                        video_data = Some((generate_test_frame(w, h), w, h));
                                    }
                                }
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

                // ── Drain encoded video → shared memory ──
                let timestamp_us = start_instant.elapsed().as_micros().min(u32::MAX as u128) as u32;
                drain_to_shm_video(&ctx.app_state, &ctx.shm, timestamp_us).await;

                // ── Drain encoded audio → shared memory ──
                audio_ts = drain_to_shm_audio(&ctx.app_state, &ctx.shm, audio_ts, &mut audio_write_errs).await;
            }
        }
    }

    tracing::info!("[STREAM] Loop exited");
}
