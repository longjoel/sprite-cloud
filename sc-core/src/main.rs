//! sc-core — minimal libretro child process.
//!
//! Usage: sc-core <core.so> <rom> <out_shm> <in_shm>
//!
//! Loads the libretro core and ROM, maps two shared memory regions,
//! then runs the core loop:
//!   - Reads commands from in_shm (server → core)
//!   - Writes frames + audio to out_shm (core → server)
//!
//! Exits with code 0 on clean shutdown, non-zero on error or signal.
//! The parent (sc-server) detects exit via waitpid / process handle.

use std::sync::atomic::Ordering;
use std::time::{Duration, Instant};

use sc_core::{OutputShm, InputShm, map_shm};

/// Target sample rate sc-core emits. sc-core owns ALL rate conversion so the
/// server's GStreamer chain always receives exactly this rate and can never
/// drift from the reported rate, regardless of what a core advertises.
const AUDIO_TARGET_RATE: f64 = 48000.0;

/// Resample interleaved audio (any channel count) from `in_rate` to `out_rate`
/// by linear interpolation. Handles both upsampling and downsampling.
/// Returns the input unchanged when rates are ~equal or input is degenerate.
fn resample_audio(input: &[i16], in_rate: f64, out_rate: f64, channels: usize) -> Vec<i16> {
    let input_frames = input.len() / channels;
    if input_frames == 0
        || in_rate <= 0.0
        || out_rate <= 0.0
        || (in_rate - out_rate).abs() < 0.5
    {
        return input.to_vec();
    }
    let ratio = in_rate / out_rate; // input frames consumed per output frame
    let output_frames = (input_frames as f64 / ratio).round() as usize;
    if output_frames == 0 {
        return input.to_vec();
    }
    let mut out = Vec::with_capacity(output_frames * channels);
    for j in 0..output_frames {
        let pos = j as f64 * ratio; // position in input frames
        let i0 = pos.floor() as usize;
        let frac = (pos - i0 as f64) as f32;
        if i0 >= input_frames {
            break;
        }
        let i1 = (i0 + 1).min(input_frames - 1);
        let base0 = i0 * channels;
        let base1 = i1 * channels;
        for c in 0..channels {
            let a = input[base0 + c] as f32;
            let b = input[base1 + c] as f32;
            let v = a + (b - a) * frac;
            out.push(v.round() as i16);
        }
    }
    out
}

/// Vertically line-double an RGB24 frame (each input row duplicated straight
/// down). Used to display interlaced half-height fields — e.g. parallel_n64's
/// 640×240 N64 fields — at the full 480-line height so the browser shows a
/// proper 4:3 image instead of an 8:3 half-height one.
fn line_double_vertical_rgb24(input: &[u8], width: usize, height: usize) -> Vec<u8> {
    let row_bytes = width * 3;
    let mut out = Vec::with_capacity(row_bytes * height * 2);
    for row in 0..height {
        let start = row * row_bytes;
        let end = start + row_bytes;
        if end > input.len() {
            break;
        }
        let row_data = &input[start..end];
        out.extend_from_slice(row_data);
        out.extend_from_slice(row_data);
    }
    out
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 5 {
        eprintln!("Usage: {} <core.so> <rom> <out_shm> <in_shm> [system_dir]", args[0]);
        std::process::exit(1);
    }
    
    let core_path = &args[1];
    let rom_path = &args[2];
    let out_name = &args[3];
    let in_name = &args[4];
    let system_dir = args.get(5).cloned().unwrap_or_else(|| "/tmp".into());
    // Optional 6th arg: "mono" — mirror the live audio channel into both.
    // Set by sc-server for platforms whose hardware is unconditionally mono.
    let mono = args.get(6).is_some_and(|flag| flag == "mono");
    
    // Map shared memory
    let out_mmap = map_shm::<OutputShm>(out_name, OutputShm::size())
        .unwrap_or_else(|e| {
            eprintln!("FATAL: out shm {out_name}: {e}");
            std::process::exit(2);
        });
    let in_mmap = map_shm::<InputShm>(in_name, InputShm::size())
        .unwrap_or_else(|e| {
            eprintln!("FATAL: in shm {in_name}: {e}");
            std::process::exit(2);
        });
    
    let out: &OutputShm = unsafe { &*(out_mmap.as_ptr() as *const OutputShm) };
    let inp: &InputShm = unsafe { &*(in_mmap.as_ptr() as *const InputShm) };
    
    // Load core
    let core_config = libretro_runner::CoreConfig {
        core_path: core_path.into(),
        content_path: Some(rom_path.into()),
        system_dir: system_dir.into(),
        save_dir: "/tmp".into(),
        audio_channels: 2,
        mono,
    };
    
    let mut core = match unsafe { libretro_runner::Core::load(core_config) } {
        Ok(c) => c,
        Err(e) => {
            eprintln!("FATAL: load core {core_path}: {e}");
            std::process::exit(3);
        }
    };
    
    let mut sample_rate = core.av_info.sample_rate;
    if sample_rate <= 0.0 {
        let _ = core.run_frame();
        sample_rate = core.av_info.sample_rate;
    }
    
    let width = core.av_info.base_width;
    let height = core.av_info.base_height;
    let fps = core.av_info.fps;
    let frame_interval = Duration::from_secs_f64(1.0 / fps.max(1.0));
    
    eprintln!("[core] loaded {width}x{height} @ {fps:.1}fps {sample_rate:.0}Hz");
    
    // Write metadata to output shm so server knows dimensions before first frame
    out.base_width.store(width, Ordering::Relaxed);
    out.base_height.store(height, Ordering::Relaxed);
    out.fps_x1000.store((fps * 1000.0) as u32, Ordering::Relaxed);
    // sc-core always emits a fixed 48 kHz; the server reads this to configure
    // its audio encoder (identity GStreamer resample).
    out.sample_rate.store(AUDIO_TARGET_RATE as u32, Ordering::Relaxed);
    
    // ── Frame loop ───────────────────────────────────────────────────
    let mut frame_num: u64 = 0;
    loop {
        let tick_start = Instant::now();
        
        // Read command from server
        if inp.cmd_ready.load(Ordering::Acquire) {
            let cmd_type = inp.cmd_type.load(Ordering::Relaxed);
            match cmd_type {
                sc_core::CMD_SET_INPUT => {
                    let port = inp.port.load(Ordering::Relaxed);
                    let state = inp.state.load(Ordering::Relaxed);
                    core.set_input(port, state);
                }
                sc_core::CMD_SAVE_STATE => {
                    let _slot = inp.slot.load(Ordering::Relaxed);
                    let data = core.save_state().unwrap_or_default();
                    let len = data.len().min(sc_core::MAX_RESPONSE);
                    // Write response data
                    let resp_ptr = out.response_data.as_ptr() as *mut u8;
                    unsafe { std::ptr::copy_nonoverlapping(data.as_ptr(), resp_ptr, len) };
                    out.response_data_len.store(len as u32, Ordering::Relaxed);
                    out.response_ok.store(!data.is_empty(), Ordering::Relaxed);
                }
                sc_core::CMD_LOAD_STATE => {
                    let len = out.response_data_len.load(Ordering::Relaxed) as usize;
                    let data = &out.response_data[..len.min(sc_core::MAX_RESPONSE)];
                    let ok = core.load_state(data);
                    out.response_ok.store(ok, Ordering::Relaxed);
                }
                sc_core::CMD_SAVE_SRAM => {
                    match core.sram() {
                        Some(data) => {
                            let len = data.len().min(sc_core::MAX_RESPONSE);
                            let resp_ptr = out.response_data.as_ptr() as *mut u8;
                            unsafe { std::ptr::copy_nonoverlapping(data.as_ptr(), resp_ptr, len); }
                            out.response_data_len.store(len as u32, Ordering::Relaxed);
                            out.response_ok.store(true, Ordering::Relaxed);
                        }
                        None => {
                            out.response_data_len.store(0, Ordering::Relaxed);
                            out.response_ok.store(false, Ordering::Relaxed);
                        }
                    }
                }
                sc_core::CMD_LOAD_SRAM => {
                    let len = out.response_data_len.load(Ordering::Relaxed) as usize;
                    if len > 0 {
                        let data = &out.response_data[..len.min(sc_core::MAX_RESPONSE)];
                        core.restore_sram(data);
                        out.response_ok.store(true, Ordering::Relaxed);
                    } else {
                        out.response_ok.store(false, Ordering::Relaxed);
                    }
                }
                sc_core::CMD_RESET => {
                    core.reset();
                }
                _ => {}
            }
            inp.cmd_ready.store(false, Ordering::Release);
        }
        
        // Run one frame
        if let Err(e) = core.run_frame() {
            eprintln!("[core] run_frame failed: {e} — exiting");
            std::process::exit(4);
        }
        
        // Write frame to output shm
        if let Some(pixels) = core.frame() {
            let (fw0, fh0) = core.frame_size();
            let raw_audio = core.drain_audio();

            // ── Resample ALL audio to a fixed 48 kHz here ───────────
            // sc-core owns every rate conversion (up or down), so the server's
            // GStreamer chain always sees exactly 48 kHz and can never drift
            // from the reported rate, regardless of what a core advertises.
            // Handles N64/parallel_n64 (32040 Hz, previously left to GStreamer's
            // audioresample) as well as 2 MHz+ cores (SameBoy).
            let audio = resample_audio(&raw_audio, sample_rate, AUDIO_TARGET_RATE, 2);
            out.sample_rate.store(AUDIO_TARGET_RATE as u32, Ordering::Relaxed);

            // ── Line-double interlaced half-height fields ──────────
            // parallel_n64 (N64) delivers 640×240 interlaced fields while the
            // base geometry is 640×480. Presented raw, that field is 8:3 and
            // the browser shows a half-height image. When a frame is exactly
            // half the base height at full base width, line-double vertically
            // to the full base height so the image displays at the proper 4:3.
            let (fw, fh, frame) = if fh0 > 0 && fh0 * 2 == height && fw0 == width {
                let doubled = line_double_vertical_rgb24(pixels, fw0 as usize, fh0 as usize);
                (fw0, height, doubled)
            } else {
                (fw0, fh0, pixels.to_vec())
            };

            let px_count = (fw as usize * fh as usize * 3).min(sc_core::MAX_PIXELS);
            unsafe {
                std::ptr::copy_nonoverlapping(
                    frame.as_ptr(),
                    out.pixels.as_ptr() as *mut u8,
                    px_count,
                );
            }
            let audio_count = audio.len().min(sc_core::MAX_AUDIO);
            unsafe {
                std::ptr::copy_nonoverlapping(
                    audio.as_ptr(),
                    out.audio.as_ptr() as *mut i16,
                    audio_count,
                );
            }

            out.width.store(fw, Ordering::Relaxed);
            out.height.store(fh, Ordering::Relaxed);
            out.audio_len.store(audio.len() as u32, Ordering::Relaxed);
            out.frame_ready.store(true, Ordering::Release);
        }
        
        frame_num = frame_num.wrapping_add(1);
        
        // Pace to target FPS
        let elapsed = tick_start.elapsed();
        if let Some(remaining) = frame_interval.checked_sub(elapsed) {
            if !remaining.is_zero() {
                std::thread::sleep(remaining);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn interleaved(frames: usize, channels: usize) -> Vec<i16> {
        (0..frames * channels).map(|i| i as i16).collect()
    }

    #[test]
    fn equal_rates_are_identity() {
        let input = interleaved(100, 2);
        let out = resample_audio(&input, 48000.0, 48000.0, 2);
        assert_eq!(out, input);
    }

    #[test]
    fn upsample_scales_frames_in_half() {
        // 32040 Hz (parallel_n64) -> 48000 Hz: 3204 frames -> 4800 frames.
        let input = interleaved(3204, 2);
        let out = resample_audio(&input, 32040.0, 48000.0, 2);
        assert_eq!(out.len() / 2, 4800, "32040->48000 frame count");
        // Interleaving preserved: per-frame L/R both non-zero and distinct.
        assert_ne!(out[0], out[1]);
    }

    #[test]
    fn upsample_preserves_trailing_channels() {
        let input = interleaved(200, 2);
        let out = resample_audio(&input, 32040.0, 48000.0, 2);
        // First output frame interpolates the first input frame (offset ~0).
        assert_eq!(out[0], input[0]);
        // Output stays stereo-interleaved and the final frame has both channels.
        assert_eq!(out.len() % 2, 0);
        assert!(out.len() >= 2);
    }

    #[test]
    fn downsample_2mhz_slugs_to_1_48th() {
        let input = interleaved(2_000_000 / 60, 2); // one 60fps frame at 2 MHz
        let out = resample_audio(&input, 2_000_000.0, 48000.0, 2);
        let expect = ((2_000_000 / 60) as f64 * 48000.0 / 2_000_000.0).round() as usize;
        assert_eq!(out.len() / 2, expect);
    }

    #[test]
    fn degenerate_cases_return_input() {
        assert_eq!(resample_audio(&[], 32040.0, 48000.0, 2), vec![]);
        let input = interleaved(10, 2);
        assert_eq!(resample_audio(&input, 0.0, 48000.0, 2), input);
        assert_eq!(resample_audio(&input, 32040.0, 0.0, 2), input);
    }

    #[test]
    fn line_double_doubles_height_and_repeats_each_row() {
        // 2x1 RGB frame: row0 = [1,2,3]
        let input = vec![1u8, 2, 3, 4, 5, 6]; // w=2,h=1
        let out = line_double_vertical_rgb24(&input, 2, 1);
        assert_eq!(out.len(), 2 * 2 * 3);
        // Each input row appears twice, in order.
        assert_eq!(&out[0..6], &[1, 2, 3, 4, 5, 6]);
        assert_eq!(&out[6..12], &[1, 2, 3, 4, 5, 6]);
    }

    #[test]
    fn line_double_640x240_gives_640x480() {
        let w = 640usize;
        let h = 240usize;
        let input = vec![17u8; w * h * 3];
        let out = line_double_vertical_rgb24(&input, w, h);
        assert_eq!(out.len(), w * 480 * 3);
        assert_eq!(out.len(), sc_core::MAX_PIXELS);
        // Row 0 and row 240 are identical (repeated), as is the whole frame.
        assert_eq!(&out[0..w * 3], &out[w * 3..w * 6]);
        assert!(out.iter().all(|&b| b == 17));
    }
}
