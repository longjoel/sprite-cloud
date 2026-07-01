//! GStreamer Opus audio encoder.
//!
//! Pipeline: appsrc → audioconvert → audioresample → opusenc → appsink
//!
//! Push interleaved i16 PCM at 48 kHz (downsampled in gv-core),
//! pull Opus-encoded packets.

use gstreamer as gst;
use gstreamer::prelude::*;
use gstreamer_app as gst_app;

pub struct GstAudioEncoder {
    pipeline: gst::Pipeline,
    appsrc: gst_app::AppSrc,
    appsink: gst_app::AppSink,
    sample_rate: u32,
    channels: u16,
    samples_pushed: u64,
}

impl GstAudioEncoder {
    pub fn new(core_sample_rate: f64, channels: u16) -> Result<Self, String> {
        if core_sample_rate <= 0.0 {
            return Err("core_sample_rate must be positive".into());
        }
        if channels == 0 {
            return Err("channels must be positive".into());
        }

        let rate = core_sample_rate.round() as u32;
        let bitrate = crate::config::gst_audio_bitrate();

        let pipeline_str = format!(
            "appsrc name=audio_src is-live=true format=time \
             ! audioconvert ! audioresample \
             ! audio/x-raw,rate=48000,channels=2 \
             ! opusenc \
               audio-type=restricted-lowdelay \
               frame-size=20 \
               bitrate={br} \
               inband-fec=true \
             ! appsink name=audio_sink sync=false async=false drop=true max-buffers=4",
            br = bitrate,
        );

        let pipeline = gst::parse::launch(&pipeline_str)
            .map_err(|e| format!("audio pipeline launch: {e}"))?
            .downcast::<gst::Pipeline>()
            .map_err(|e| format!("not a Pipeline: {e:?}"))?;

        let appsrc = pipeline
            .by_name("audio_src")
            .ok_or("audio_src not found")?
            .downcast::<gst_app::AppSrc>()
            .map_err(|e| format!("audio_src: {e:?}"))?;

        let appsink = pipeline
            .by_name("audio_sink")
            .ok_or("audio_sink not found")?
            .downcast::<gst_app::AppSink>()
            .map_err(|e| format!("audio_sink: {e:?}"))?;

        let caps = gst::Caps::builder("audio/x-raw")
            .field("format", "S16LE")
            .field("rate", rate as i32)
            .field("channels", channels as i32)
            .field("layout", "interleaved")
            .build();
        appsrc.set_caps(Some(&caps));
        appsrc.set_property("format", gst::Format::Time);
        appsrc.set_property("is-live", true);
        appsrc.set_max_bytes(((rate * channels as u32 * 2) / 2) as u64);

        pipeline
            .set_state(gst::State::Playing)
            .map_err(|e| format!("audio set Playing: {e}"))?;

        tracing::info!(
            "[GST-audio] {}ch {}Hz → 48kHz, opusenc {}bps",
            channels, rate, bitrate,
        );

        Ok(Self {
            pipeline,
            appsrc,
            appsink,
            sample_rate: rate,
            channels,
            samples_pushed: 0,
        })
    }

    pub fn push(&mut self, samples: &[i16]) {
        if samples.is_empty() {
            return;
        }
        let bytes: Vec<u8> = samples.iter().flat_map(|s| s.to_le_bytes()).collect();
        let mut buffer = gst::Buffer::from_slice(bytes);
        {
            let buf = buffer.make_mut();
            let sample_count = (samples.len() / self.channels as usize) as u64;
            let pts_ns = self.samples_pushed
                .saturating_mul(1_000_000_000)
                .checked_div(self.sample_rate as u64)
                .unwrap_or(0);
            let dur_ns = sample_count
                .saturating_mul(1_000_000_000)
                .checked_div(self.sample_rate as u64)
                .unwrap_or(0);
            buf.set_pts(gst::ClockTime::from_nseconds(pts_ns));
            buf.set_duration(gst::ClockTime::from_nseconds(dur_ns));
        }
        self.samples_pushed += samples.len() as u64 / self.channels as u64;
        if let Err(e) = self.appsrc.push_buffer(buffer) {
            tracing::warn!("[GST-audio] push failed: {e}");
        }
    }

    /// Non-blocking pull. Returns `None` if no Opus frame ready.
    pub fn try_pull(&self) -> Option<Vec<u8>> {
        let sample = self.appsink.try_pull_sample(gst::ClockTime::ZERO)?;
        let buffer = sample.buffer()?;
        let map = buffer.map_readable().ok()?;
        Some(map.to_vec())
    }

    pub fn channels(&self) -> u16 {
        self.channels
    }
    pub fn sample_rate(&self) -> u32 {
        self.sample_rate
    }
}

impl Drop for GstAudioEncoder {
    fn drop(&mut self) {
        let _ = self.pipeline.set_state(gst::State::Null);
    }
}
