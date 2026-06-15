//! Audio pipeline — resampling + Opus frame chunking.
//!
//! The problem: libretro cores produce interleaved stereo i16 PCM at their
//! native sample rate (e.g. 49.7 kHz for NES), in per-frame batches that
//! are not multiples of valid Opus frame sizes.
//!
//! This module:
//! 1. Resamples from the core's rate to 48 kHz (Opus native) via rubato
//! 2. Chunks resampled audio into fixed 20ms Opus frames (960 stereo samples)
//! 3. Encodes each complete frame with the opus crate
//!
//! # Buffering limits
//!
//! Input is capped at ~500ms of core audio; output at ~200ms of 48kHz audio.
//! When the pipeline falls behind, oldest audio is dropped (with a warning)
//! rather than growing unbounded. This prevents OOM on rate mismatches or
//! CPU contention.

use rubato::audioadapter_buffers::direct::InterleavedSlice;
use rubato::Resampler;

use crate::config::{AUDIO_SAMPLE_RATE, OPUS_MAX_FRAME_BYTES};

/// Opus frame size in stereo samples at 48 kHz.
/// 960 samples per channel = 20 ms, the most common Opus frame duration.
const OPUS_FRAME_STEREO_SAMPLES: usize = 960 * 2; // 1920 i16 values

/// Output chunk size in samples per channel (one Opus frame worth).
pub const OUTPUT_CHUNK_SAMPLES: usize = 960;

/// How many channels we resample and encode.
const CHANNELS: usize = 2;

/// Max output buffer in stereo i16 samples (~200ms @ 48kHz).
/// 48_000 * 0.2 * 2 = 19_200 samples ≈ 38 KiB.
const MAX_OUTPUT_SAMPLES: usize = 19_200;

/// An Opus-encoded audio packet ready for WebRTC.
pub struct OpusPacket {
    pub data: Vec<u8>,
}

/// Audio processing pipeline with resampling and Opus frame chunking.
pub struct AudioPipeline {
    /// Rubato resampler: core rate → 48 kHz, fixed output size
    resampler: rubato::Fft<f64>,
    /// Buffered input waiting to be fed to the resampler.
    /// Interleaved f64 samples, waiting until we have enough for one chunk.
    input_buf: Vec<f64>,
    /// Max input samples allowed before the oldest are dropped.
    max_input_samples: usize,
    /// Resampled output buffer. Interleaved i16 samples at 48 kHz.
    /// Drained in 960×2 chunks for Opus encoding.
    output_buf: Vec<i16>,
    /// Pre-allocated output buffer for rubato resampling.
    /// Reused across `try_encode` calls to avoid per-chunk allocation.
    resample_output: Vec<f64>,
    /// Opus encoder (stereo, 48 kHz, audio profile).
    opus_encoder: opus::Encoder,
    /// Diagnostic: number of times input was trimmed.
    input_trims: u64,
    /// Diagnostic: number of times output was trimmed.
    output_trims: u64,
}

impl AudioPipeline {
    /// Create a new audio pipeline.
    ///
    /// `core_sample_rate` is the sample rate reported by the libretro core
    /// (e.g. 49700.0 for nestopia). Audio will be resampled from this rate
    /// to `AUDIO_SAMPLE_RATE` (48 kHz).
    pub fn new(core_sample_rate: f64) -> Result<Self, Box<dyn std::error::Error + Send + Sync>> {
        if core_sample_rate <= 0.0 {
            return Err("core_sample_rate must be positive".into());
        }

        let resampler = rubato::Fft::<f64>::new(
            core_sample_rate as usize,
            AUDIO_SAMPLE_RATE as usize,
            OUTPUT_CHUNK_SAMPLES,
            1, // sub_chunks
            CHANNELS,
            rubato::FixedSync::Output,
        )
        .map_err(|e| format!("rubato init failed: {e:?}"))?;

        let opus_encoder = opus::Encoder::new(
            AUDIO_SAMPLE_RATE,
            opus::Channels::Stereo,
            opus::Application::Audio,
        )
        .map_err(|e| format!("opus init failed: {e}"))?;

        // Input cap: ~500ms of core audio (rate-dependent, set at construction)
        let max_input_samples = (core_sample_rate * 0.5).ceil() as usize * CHANNELS;

        // Pre-allocate the resample output buffer
        let resample_output = vec![0f64; OUTPUT_CHUNK_SAMPLES * CHANNELS];

        tracing::info!(
            "[AUDIO] Pipeline created: {:.0}Hz → {}Hz, ratio={:.4}, output_chunk={} frames, \
             max_input={} samples ({:.0}ms), max_output={} samples",
            core_sample_rate,
            AUDIO_SAMPLE_RATE,
            AUDIO_SAMPLE_RATE as f64 / core_sample_rate,
            OUTPUT_CHUNK_SAMPLES,
            max_input_samples,
            max_input_samples as f64 / core_sample_rate * 1000.0 / CHANNELS as f64,
            MAX_OUTPUT_SAMPLES,
        );

        Ok(Self {
            resampler,
            input_buf: Vec::new(),
            max_input_samples,
            output_buf: Vec::new(),
            resample_output,
            opus_encoder,
            input_trims: 0,
            output_trims: 0,
        })
    }

    /// Push interleaved stereo i16 PCM samples from the core.
    ///
    /// Call this once per video frame with whatever audio the core produced.
    /// The pipeline buffers internally. If the input buffer exceeds
    /// `max_input_samples`, the oldest samples are silently dropped.
    pub fn push(&mut self, samples: &[i16]) {
        if samples.is_empty() {
            return;
        }
        self.input_buf.reserve(samples.len());
        for &s in samples {
            self.input_buf.push(s as f64);
        }
        // Cap: drop oldest samples if we're over the limit
        if self.input_buf.len() > self.max_input_samples {
            let excess = self.input_buf.len() - self.max_input_samples;
            self.input_buf.drain(..excess);
            self.input_trims = self.input_trims.wrapping_add(1);
            tracing::warn!(
                "[AUDIO] Input buffer trimmed by {} samples (total trims: {}) — \
                 pipeline can't keep up with core audio rate",
                excess, self.input_trims,
            );
        }
    }

    /// Try to produce one Opus-encoded packet.
    ///
    /// Returns `None` if there isn't enough accumulated audio yet to fill
    /// a complete 20ms Opus frame. Returns `Some(packet)` when a complete
    /// frame is ready.
    ///
    /// Call this once per streaming loop tick, after `push()`.
    pub fn try_encode(&mut self) -> Result<Option<OpusPacket>, String> {
        // --- Step 1: resample ---
        // Feed chunks to rubato as long as we have enough input.
        loop {
            let needed = self.resampler.input_frames_next();
            let samples_needed = needed * CHANNELS;
            if self.input_buf.len() < samples_needed {
                break;
            }

            // Wrap our interleaved buffer as a rubato adapter
            let wave_in = &self.input_buf[..samples_needed];
            let input_adapter = InterleavedSlice::new(wave_in, CHANNELS, needed)
                .map_err(|e| format!("input adapter: {e:?}"))?;

            // Reuse pre-allocated output buffer — clear it first
            self.resample_output.fill(0.0);
            let mut output_adapter = InterleavedSlice::new_mut(
                &mut self.resample_output,
                CHANNELS,
                OUTPUT_CHUNK_SAMPLES,
            )
            .map_err(|e| format!("output adapter: {e:?}"))?;

            self.resampler
                .process_into_buffer(&input_adapter, &mut output_adapter, None)
                .map_err(|e| format!("rubato process_into_buffer failed: {e:?}"))?;

            // Drain consumed input
            self.input_buf.drain(..samples_needed);

            // Convert output f64 → i16
            for &sample in &self.resample_output {
                let s = sample.round().clamp(i16::MIN as f64, i16::MAX as f64) as i16;
                self.output_buf.push(s);
            }
        }

        // Cap output buffer: drop oldest if over the limit
        if self.output_buf.len() > MAX_OUTPUT_SAMPLES {
            let excess = self.output_buf.len() - MAX_OUTPUT_SAMPLES;
            // Drain in whole-Opus-frame increments to avoid partial frames
            let drain = (excess / OPUS_FRAME_STEREO_SAMPLES) * OPUS_FRAME_STEREO_SAMPLES;
            if drain > 0 {
                self.output_buf.drain(..drain);
                self.output_trims = self.output_trims.wrapping_add(1);
                tracing::warn!(
                    "[AUDIO] Output buffer trimmed by {} samples ({} Opus frames, total trims: {})",
                    drain,
                    drain / OPUS_FRAME_STEREO_SAMPLES,
                    self.output_trims,
                );
            }
        }

        // --- Step 2: encode Opus frames ---
        if self.output_buf.len() >= OPUS_FRAME_STEREO_SAMPLES {
            let opus_input: Vec<i16> = self
                .output_buf
                .drain(..OPUS_FRAME_STEREO_SAMPLES)
                .collect();

            let opus_data = self
                .opus_encoder
                .encode_vec(&opus_input, OPUS_MAX_FRAME_BYTES)
                .map_err(|e| format!("opus encode failed: {e}"))?;

            Ok(Some(OpusPacket { data: opus_data }))
        } else {
            Ok(None)
        }
    }

    /// Number of input samples currently buffered (for diagnostics).
    #[allow(dead_code)]
    pub fn buffered_input_samples(&self) -> usize {
        self.input_buf.len()
    }

    /// Number of resampled output samples waiting to be encoded (for diagnostics).
    #[allow(dead_code)]
    pub fn buffered_output_samples(&self) -> usize {
        self.output_buf.len()
    }
}
