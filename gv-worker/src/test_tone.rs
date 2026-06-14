//! 440 Hz sine wave test tone — 16-bit mono PCM @ 48 kHz.
//!
//! Generates 960 samples per frame (20 ms at 48 kHz), suitable for
//! the Opus codec's default frame size.

pub const SAMPLE_RATE: u32 = 48_000;
pub const CHANNELS: u16 = 1;
pub const SAMPLES_PER_FRAME: usize = 960; // 20ms @ 48kHz

/// Generate one frame of 440 Hz sine wave samples.
/// Returns i16 interleaved mono PCM.
pub fn generate_tone(frame_num: u64) -> Vec<i16> {
    let freq = 440.0;
    let samples = SAMPLES_PER_FRAME;
    let mut buf = Vec::with_capacity(samples);
    let phase_offset = (frame_num as f64 * samples as f64) / SAMPLE_RATE as f64 * freq * 2.0 * std::f64::consts::PI;
    for i in 0..samples {
        let t = i as f64 / SAMPLE_RATE as f64;
        let sample = (phase_offset + t * freq * 2.0 * std::f64::consts::PI).sin();
        buf.push((sample * 16_384.0) as i16); // -18 dBFS to avoid clipping
    }
    buf
}
