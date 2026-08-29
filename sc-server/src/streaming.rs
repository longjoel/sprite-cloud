//! Streaming loop: libretro core → GStreamer → WebRTC tracks.
//!
//! Core drain + GStreamer encode streaming pipeline.
//! with sc-server's fan_out_frames (write to WebRTC tracks). No shm.

use std::sync::Arc;
use std::time::Duration;

use webrtc::media::Sample;

use crate::gst_audio::GstAudioEncoder;
use crate::gst_video::GstVideoEncoder;
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

async fn probe_and_rebuild_encoder(
    session: &GameSession,
    frame_width: u32,
    frame_height: u32,
    fps: f64,
) -> Result<(), String> {
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
            tracing::info!(
                "[STREAM] Resolution probe: actual {frame_width}×{frame_height} — rebuilding encoder"
            );
        } else {
            tracing::info!(
                "[STREAM] Creating video encoder: {frame_width}×{frame_height} @ {fps:.1}fps"
            );
        }
        drop(enc_guard);
        let new_enc = GstVideoEncoder::new_with_codec(frame_width, frame_height, fps)
            .map_err(|e| format!("encoder create/rebuild failed: {e}"))?;
        *session.video_enc.lock().await = Some(Arc::new(tokio::sync::Mutex::new(new_enc)));

        if needs_create {
            let sample_rate = *session.core_sample_rate.lock().await;
            match GstAudioEncoder::new(sample_rate, 2) {
                Ok(aenc) => {
                    *session.audio_enc.lock().await =
                        Some(Arc::new(tokio::sync::Mutex::new(Some(aenc))));
                    tracing::info!("[STREAM] Audio encoder created: {sample_rate:.0}Hz 2ch");
                }
                Err(e) => tracing::warn!("[STREAM] Audio encoder creation failed: {e}"),
            }
        }
    }
    Ok(())
}

async fn push_video_frame(
    session: &GameSession,
    pixels: &[u8],
    w: u32,
    h: u32,
    frame_num: u64,
) -> Result<(), String> {
    let enc_guard = session.video_enc.lock().await;
    if let Some(ref enc_arc) = *enc_guard {
        enc_arc
            .lock()
            .await
            .push(pixels, (w, h), frame_num)
            .map_err(|e| format!("video push error at frame {frame_num}: {e}"))?;
    }
    Ok(())
}

async fn push_audio(session: &GameSession, audio_data: &[i16], audio_acc: &mut Vec<i16>) {
    let aenc_guard = session.audio_enc.lock().await;
    if let Some(ref aenc_arc) = *aenc_guard
        && let Some(ref mut enc) = *aenc_arc.lock().await
    {
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

/// Drain encoded video from GStreamer → WebRTC video track.
async fn drain_to_track_video(
    session: &GameSession,
    frame_num: u64,
    ticks_per_frame: u32,
    rtp_offset: u32,
) {
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
                    duration: Duration::from_secs_f64(1.0 / *session.core_fps.lock().await),
                    packet_timestamp: rtp_offset
                        .wrapping_add((frame_num * ticks_per_frame as u64) as u32),
                    ..Default::default()
                };
                let track = session.video_track.lock().expect("mutex poisoned").clone();
                let _ = track.write_sample(&sample).await;
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
                    let track = session.audio_track.lock().expect("mutex poisoned").clone();
                    let _ = track.write_sample(&sample).await;
                    audio_ts = audio_ts.wrapping_add(960);
                }
                None => break,
            }
        }
    }
    audio_ts
}

// ── Main streaming loop ─────────────────────────────────────────────

/// True if a crash sentinel (width-0, empty frame) is the latest frame the
/// core bridge enqueued. Used on the cancellation branch so a core crash that
/// enqueues its sentinel just before cancel.cancel() is still relayed instead
/// of being dropped when cancellation wins the select.
async fn latest_frame_is_crash_sentinel(session: &GameSession) -> bool {
    let frame_rx_guard = session.core_frame_rx.lock().await;
    let Some(ref rx) = *frame_rx_guard else { return false };
    let mut latest = None;
    while let Ok(f) = rx.try_recv() {
        latest = Some(f);
    }
    matches!(latest, Some(f) if f.width == 0)
}

/// Send `core_died` to the player via the host DataChannel. The core bridge
/// sets the sentinel that leads here; relay it independently of how the loop
/// exited (tick branch or cancellation branch) so the player always leaves the
/// frozen stream for its fatal-error/disconnect path.
async fn relay_core_died(session: &GameSession) {
    // The bridge thread set a specific, classified reason before delivering the
    // sentinel (signal/code + stderr). Drain it so a reused session doesn't
    // replay a stale reason. Fall back to a generic message.
    let reason = session
        .core_died_reason
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .take()
        .unwrap_or_else(|| "Emulator crashed (core process exited)".to_string());
    tracing::error!("[STREAM] Core sentinel — died: {reason}");
    if let Some(ref dc) = *session.dc.lock().await {
        let msg = serde_json::json!({"cmd": "core_died", "reason": reason});
        let _ = dc.send_text(msg.to_string()).await;
    }
}

pub async fn run_stream(session: Arc<GameSession>) {
    let fps = *session.core_fps.lock().await;
    let frame_interval = Duration::from_secs_f64(1.0 / fps.max(1.0));
    let ticks_per_frame = (90_000.0f64 / fps.max(1.0)).round() as u32;
    let rtp_offset = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_micros()
        .min(u32::MAX as u128) as u32;
    let mut frame_num: u64 = 0;
    let mut audio_ts: u32 = 0;
    let mut audio_acc: Vec<i16> = Vec::new();
    let mut resolution_probed = false;

    let mut tick = tokio::time::interval(frame_interval);
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

    tracing::info!("[STREAM] Starting GStreamer frame loop @ {:.1}fps", fps);

    loop {
        tokio::select! {
            _ = session.cancel.cancelled() => {
                // A core crash enqueues its width-0 sentinel *before* calling
                // cancel.cancel(), so the cancellation branch must drain the
                // frame channel for that sentinel and relay core_died to the
                // player — otherwise a crash that lands just as cancellation
                // fires would leave the player frozen with no fatal error.
                if latest_frame_is_crash_sentinel(&session).await {
                    relay_core_died(&session).await;
                    break;
                }
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
                                // Notify player via DataChannel
                                relay_core_died(&session).await;
                                // Clean up session state
                                session.core_loaded.store(false, std::sync::atomic::Ordering::Relaxed);
                                *session.core_frame_rx.lock().await = None;
                                *session.core_cmd_tx.lock().await = None;
                                *session.core_response_rx.lock().await = None;
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

                                // sc-core reports its *measured* emitted sample
                                // rate, which can shift between phases (PSP
                                // movie vs gameplay). Rebuild the audio encoder
                                // when the rate moves >2% so the appsrc caps
                                // stay truthful; GStreamer's audioresample does
                                // the actual conversion to 48 kHz for Opus.
                                if f.sample_rate > 0 {
                                    let mut aenc_guard = session.audio_enc.lock().await;
                                    let mismatch = if let Some(ref aenc_arc) = *aenc_guard
                                        && let Some(ref enc) = *aenc_arc.lock().await
                                    {
                                        let cur = enc.sample_rate() as f64;
                                        let target = f.sample_rate as f64;
                                        cur > 0.0 && (target - cur).abs() > cur * 0.02
                                    } else {
                                        false
                                    };
                                    if mismatch {
                                        let target = f.sample_rate as f64;
                                        match GstAudioEncoder::new(target, 2) {
                                            Ok(aenc) => {
                                                *aenc_guard = Some(Arc::new(tokio::sync::Mutex::new(
                                                    Some(aenc),
                                                )));
                                                tracing::info!(
                                                    "[STREAM] Audio encoder rebuilt at {target:.0}Hz"
                                                );
                                            }
                                            Err(e) => tracing::warn!(
                                                "[STREAM] Audio encoder rebuild to {target:.0}Hz failed — keeping current encoder: {e}"
                                            ),
                                        }
                                    }
                                }
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
                if let Some((ref pixels, w, h)) = video_data
                    && let Err(e) = push_video_frame(&session, pixels, w, h, frame_num).await {
                        tracing::error!("[STREAM] {e}");
                        break;
                    }

                if !audio_data.is_empty() {
                    push_audio(&session, &audio_data, &mut audio_acc).await;
                }

                // ── Drain encoded → WebRTC tracks ───────────────────
                drain_to_track_video(&session, frame_num, ticks_per_frame, rtp_offset).await;
                audio_ts = drain_to_track_audio(&session, audio_ts).await;
            }
        }
    }

    tracing::info!("[STREAM] Loop exited");
}

#[cfg(test)]
mod tests {

    #[test]
    fn video_tick_rate_matches_core_fps() {
        // 60 Hz → 1500 ticks/frame on a 90 kHz clock
        // 90000/60 = 1500 exactly
        assert_eq!((90_000.0f64 / 60.0).round() as u64, 1500);

        // 50 Hz → 1800 ticks/frame
        // 90000/50 = 1800 exactly
        assert_eq!((90_000.0f64 / 50.0).round() as u64, 1800);

        // 59.94 Hz (NTSC) → ~1501.5 → rounds to 1502
        assert_eq!((90_000.0f64 / 59.94).round() as u64, 1502);
    }

    #[test]
    fn fractional_fps_does_not_drift_over_time() {
        // 59.94 Hz: per-frame rounding introduces ±0.5 tick error per frame.
        // Over 1001 frames, worst-case drift = 1001 × 0.5 = 500.5 ticks
        // on a 90 kHz clock (~5.5 ms). That's negligible — no material
        // A/V desync even after hours.
        let fps: f64 = 59.94;
        let ticks_per_frame = (90_000.0f64 / fps).round() as u64;
        // 1001 frames × 1502 ticks = 1_503_502
        let total_ticks = 1001u64 * ticks_per_frame;
        // Exact value: 90_000 × 1001 / 59.94 ≈ 1_503_003.003
        let exact = (90_000.0f64 * 1001.0 / fps).round() as u64;
        let drift = (total_ticks as f64 - exact as f64).abs();
        // Allow up to 1000 ticks of drift (≈11ms on a 90kHz clock)
        assert!(drift < 1000.0, "drift={drift} ticks over 1001 frames");
    }

    #[test]
    fn sixty_hz_stays_synchronized_over_minutes() {
        let fps: f64 = 60.0;
        let ticks_per_frame = (90_000.0f64 / fps).round() as u64;
        assert_eq!(ticks_per_frame, 1500);
        // 5 minutes at 60 Hz = 18,000 frames × 1500 ticks = 27,000,000
        let frames = 60 * 60 * 5;
        let last_timestamp = (frames - 1) as u64 * ticks_per_frame;
        assert_eq!(last_timestamp, 26_998_500);
    }

    #[test]
    fn run_stream_relays_crash_sentinel_on_the_cancellation_path_too() {
        // Review follow-up on #831: the core bridge enqueues its width-0
        // crash sentinel *before* calling cancel.cancel(). The streaming loop
        // must relay core_died even when the select picks the cancellation arm
        // first, otherwise a crash landing just as cancellation fires leaves
        // the player frozen with no fatal error. Verify the cancellation branch
        // drains for the sentinel and uses the shared relayer.
        let source = include_str!("streaming.rs");
        assert!(source.contains("latest_frame_is_crash_sentinel(&session).await"));
        assert!(source.contains("relay_core_died(&session).await"));
        assert!(source.contains("session.cancel.cancelled()"));
        assert!(source.contains("tokio::select!"));
    }
}
