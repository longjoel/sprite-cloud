//! 440 Hz sine wave test tone — 16-bit mono PCM @ 48 kHz.
//!
//! Generates 960 samples per frame (20 ms at 48 kHz), suitable for
//! the Opus codec's default frame size.

/// Number of PCM samples per Opus frame.
/// 960 samples = 20 ms @ 48 kHz — one of Opus's supported frame sizes.
/// We send one Opus frame per video tick (33.33 ms); the slight duration
/// mismatch is irrelevant for a test pattern.
pub const SAMPLES_PER_FRAME: usize = 960; // 20ms @ 48kHz

/// Generate one frame of test tone samples.
/// Returns i16 mono PCM at AUDIO_SAMPLE_RATE.
pub fn generate_tone(frame_num: u64) -> Vec<i16> {
    let freq = crate::config::TEST_TONE_FREQ;
    let amp = crate::config::TEST_TONE_AMPLITUDE;
    let samples = SAMPLES_PER_FRAME;
    let sample_rate = crate::config::AUDIO_SAMPLE_RATE as f64;
    let mut buf = Vec::with_capacity(samples);
    let phase_offset = (frame_num as f64 * samples as f64) / sample_rate * freq * 2.0 * std::f64::consts::PI;
    for i in 0..samples {
        let t = i as f64 / sample_rate;
        let sample = (phase_offset + t * freq * 2.0 * std::f64::consts::PI).sin();
        buf.push((sample * amp) as i16);
    }
    buf
}
