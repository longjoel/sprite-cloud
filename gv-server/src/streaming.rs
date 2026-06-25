//! Streaming loop: libretro core → GStreamer → WebRTC tracks.
//!
//! Merges gv-worker's stream_frames (core drain + GStreamer encode)
//! with gv-server's fan_out_frames (write to WebRTC tracks). No shm.

use std::sync::Arc;
use std::time::Duration;

use webrtc::media::Sample;

use crate::core_bridge::{CoreCommand, CoreFrame, CoreResponse};
use crate::gst_audio::GstAudioEncoder;
use crate::gst_video::{GstVideoEncoder, VideoCodec};
use crate::session::GameSession;

// ── Test pattern ─────────────────────────────────────────────────────

fn generate_test_frame(width: u32, height: u32) -> Vec<u8> {
    let pixel_count = (width * height) as usize;
    let mut pixels = Vec::with_capacity(pixel_count * 3);
    for _ in 0..pixel_count {
        pixels.push(26);
        pixels.push(20);
        pixels.push(16);
    }
    pixels
}

// ── Encoder management ──────────────────────────────────────────────

async fn probe_and_rebuild_encoder(session: &GameSession, frame_width: u32, frame_height: u32, fps: f64) -> Result<(), String> {
    if frame_width == 0 || frame_height == 0 {
        return Ok(());
    }
    let enc_guard = session.video_enc.lock().await;
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
            tracing::info!("[STREAM] Resolution probe: actual {frame_width}×{frame_height} — rebuilding encoder");
        } else {
            tracing::info!("[STREAM] Creating video encoder: {frame_width}×{frame_height} @ {fps:.1}fps");
        }
        drop(enc_guard);
        let new_enc = GstVideoEncoder::new_with_codec(frame_width, frame_height, fps, VideoCodec::H264)
            .map_err(|e| format!("encoder create/rebuild failed: {e}"))?;
        *session.video_enc.lock().await = Some(Arc::new(tokio::sync::Mutex::new(new_enc)));

        if needs_create {
            let sample_rate: f64 = 48000.0;
            match GstAudioEncoder::new(sample_rate, 2) {
                Ok(aenc) => {
                    *session.audio_enc.lock().await = Some(Arc::new(tokio::sync::Mutex::new(Some(aenc))));
                    tracing::info!("[STREAM] Audio encoder created: {sample_rate:.0}Hz 2ch");
                }
                Err(e) => tracing::warn!("[STREAM] Audio encoder creation failed: {e}"),
            }
        }
    }
    Ok(())
}

async fn push_video_frame(session: &GameSession, pixels: &[u8], w: u32, h: u32, frame_num: u64) -> Result<(), String> {
    let enc_guard = session.video_enc.lock().await;
    if let Some(ref enc_arc) = *enc_guard {
        enc_arc.lock().await.push(pixels, (w, h), frame_num)
            .map_err(|e| format!("video push error at frame {frame_num}: {e}"))?;
    }
    Ok(())
}

async fn push_audio(session: &GameSession, audio_data: &[i16], audio_acc: &mut Vec<i16>) {
    let aenc_guard = session.audio_enc.lock().await;
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

/// Drain encoded video from GStreamer → WebRTC video track.
async fn drain_to_track_video(session: &GameSession, timestamp_us: u32) {
    loop {
        let data = {
            let enc_guard = session.video_enc.lock().await;
            match enc_guard.as_ref() {
                Some(enc_arc) => enc_arc.lock().await.try_pull(),
                None => None,
            }
        };
        match data {
            Some(data) => {
                let sample = Sample {
                    data: data.into(),
                    duration: Duration::from_millis(17),
                    packet_timestamp: timestamp_us,
                    ..Default::default()
                };
                let _ = session.video_track.write_sample(&sample).await;
            }
            None => break,
        }
    }
}

/// Drain encoded audio from GStreamer → WebRTC audio track.
async fn drain_to_track_audio(session: &GameSession, mut audio_ts: u32) -> u32 {
    let aenc_guard = session.audio_enc.lock().await;
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
                    let _ = session.audio_track.write_sample(&sample).await;
                    audio_ts = audio_ts.wrapping_add(960);
                }
                None => break,
            }
        }
    }
    audio_ts
}

// ── Main streaming loop ─────────────────────────────────────────────

pub async fn run_stream(session: Arc<GameSession>) {
    let fps = *session.core_fps.lock().await;
    let frame_interval = Duration::from_secs_f64(1.0 / fps.max(1.0));
    let mut frame_num: u64 = 0;
    let mut audio_ts: u32 = 0;
    let mut audio_acc: Vec<i16> = Vec::new();
    let start_instant = std::time::Instant::now();
    let mut resolution_probed = false;

    let mut tick = tokio::time::interval(frame_interval);
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

    tracing::info!("[STREAM] Starting GStreamer frame loop @ {:.1}fps", fps);

    loop {
        tokio::select! {
            _ = session.cancel.cancelled() => {
                tracing::info!("[STREAM] Cancelled");
                break;
            }
            _ = tick.tick() => {
                // ── Drain core frames (or generate test pattern) ─────
                let mut video_data: Option<(Vec<u8>, u32, u32)> = None;
                let mut audio_data: Vec<i16> = Vec::new();

                {
                    let frame_rx_guard = session.core_frame_rx.lock().await;
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
                                if !resolution_probed {
                                    resolution_probed = true;
                                    if let Err(e) = probe_and_rebuild_encoder(&session, f.width, f.height, fps).await {
                                        tracing::error!("[STREAM] {e}");
                                        break;
                                    }
                                }
                                video_data = Some((f.pixels, f.width, f.height));
                                audio_data = f.audio;
                            }
                            None => {
                                let core_loading = session.core_loading.load(std::sync::atomic::Ordering::Relaxed);
                                let core_loaded = session.core_loaded.load(std::sync::atomic::Ordering::Relaxed);
                                if core_loading || !core_loaded {
                                    let w = *session.core_width.lock().await;
                                    let h = *session.core_height.lock().await;
                                    if w > 0 && h > 0 {
                                        video_data = Some((generate_test_frame(w, h), w, h));
                                    }
                                }
                            }
                        }
                    }
                }

                frame_num = frame_num.wrapping_add(1);

                // ── Push to GStreamer ───────────────────────────────
                if let Some((ref pixels, w, h)) = video_data {
                    if let Err(e) = push_video_frame(&session, pixels, w, h, frame_num).await {
                        tracing::error!("[STREAM] {e}");
                        break;
                    }
                }

                if !audio_data.is_empty() {
                    push_audio(&session, &audio_data, &mut audio_acc).await;
                }

                // ── Drain encoded → WebRTC tracks ───────────────────
                let timestamp_us = start_instant.elapsed().as_micros().min(u32::MAX as u128) as u32;
                drain_to_track_video(&session, timestamp_us).await;
                audio_ts = drain_to_track_audio(&session, audio_ts).await;
            }
        }
    }

    tracing::info!("[STREAM] Loop exited");
}
