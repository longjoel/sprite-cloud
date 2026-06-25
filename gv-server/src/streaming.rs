//! Frame fan-out from shared-memory ring buffer to WebRTC tracks.
//!
//! Reads encoded video (H.264) and audio (Opus) frames from the shared-memory
//! ring buffer written by gv-worker and writes them into the corresponding
//! WebRTC local tracks.  The fan-out task runs until the associated
//! cancellation token is signalled (typically when the worker is killed).

use std::sync::Arc;
use std::time::Duration;

use gv_shm::ShmRing;
use tokio_util::sync::CancellationToken;
use webrtc::media::Sample;
use webrtc::track::track_local::track_local_static_sample::TrackLocalStaticSample;

/// Poll the shared-memory ring for frames and fan them out to the
/// video and audio WebRTC tracks.
///
/// Runs until `cancel` is signalled.  Sleeps 1 ms between polls to
/// avoid busy-waiting when the ring is empty.
pub async fn fan_out_frames(
    shm: Arc<ShmRing>,
    video_track: Arc<TrackLocalStaticSample>,
    audio_track: Arc<TrackLocalStaticSample>,
    cancel: CancellationToken,
) {
    tracing::info!("[fan_out] started — polling shm ring");

    let mut video_count: u64 = 0;
    let mut audio_count: u64 = 0;
    let mut empty_count: u64 = 0;
    let mut stat_tick = tokio::time::interval(Duration::from_secs(5));

    loop {
        tokio::select! {
            _ = cancel.cancelled() => {
                tracing::info!("[fan_out] cancelled — video={video_count} audio={audio_count}");
                break;
            }
            _ = stat_tick.tick() => {
                let avail = shm.available();
                tracing::info!("[fan_out] stats: video={video_count} audio={audio_count} empty_polls={empty_count} shm_avail={avail}");
            }
            _ = tokio::time::sleep(Duration::from_millis(1)) => {
                let mut got_any = false;
                while let Some((frame_type, data, timestamp_us)) = shm.read_frame() {
                    got_any = true;
                    let sample = Sample {
                        data: data.into(),
                        duration: Duration::from_millis(17), // ~60fps
                        packet_timestamp: timestamp_us,
                        ..Default::default()
                    };
                    if frame_type == gv_shm::frame_type::VIDEO {
                        let _ = video_track.write_sample(&sample).await;
                        video_count += 1;
                    } else if frame_type == gv_shm::frame_type::AUDIO {
                        let _ = audio_track.write_sample(&sample).await;
                        audio_count += 1;
                    }
                }
                if !got_any {
                    empty_count += 1;
                }
            }
        }
    }
}
