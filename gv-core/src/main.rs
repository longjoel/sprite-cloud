//! gv-core — minimal libretro child process.
//!
//! Usage: gv-core <core.so> <rom> <out_shm> <in_shm>
//!
//! Loads the libretro core and ROM, maps two shared memory regions,
//! then runs the core loop:
//!   - Reads commands from in_shm (server → core)
//!   - Writes frames + audio to out_shm (core → server)
//!
//! Exits with code 0 on clean shutdown, non-zero on error or signal.
//! The parent (gv-server) detects exit via waitpid / process handle.

use std::sync::atomic::Ordering;
use std::time::{Duration, Instant};

use gv_core::{OutputShm, InputShm, map_shm};

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 5 {
        eprintln!("Usage: {} <core.so> <rom> <out_shm> <in_shm>", args[0]);
        std::process::exit(1);
    }
    
    let core_path = &args[1];
    let rom_path = &args[2];
    let out_name = &args[3];
    let in_name = &args[4];
    
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
        system_dir: "/tmp".into(),
        save_dir: "/tmp".into(),
        audio_channels: 2,
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
    out.sample_rate.store(sample_rate as u32, Ordering::Relaxed);
    
    // ── Frame loop ───────────────────────────────────────────────────
    let mut frame_num: u64 = 0;
    loop {
        let tick_start = Instant::now();
        
        // Read command from server
        if inp.cmd_ready.load(Ordering::Acquire) {
            let cmd_type = inp.cmd_type.load(Ordering::Relaxed);
            match cmd_type {
                gv_core::CMD_SET_INPUT => {
                    let port = inp.port.load(Ordering::Relaxed);
                    let state = inp.state.load(Ordering::Relaxed);
                    core.set_input(port, state);
                }
                gv_core::CMD_SAVE_STATE => {
                    let slot = inp.slot.load(Ordering::Relaxed);
                    let data = core.save_state().unwrap_or_default();
                    let len = data.len().min(gv_core::MAX_RESPONSE);
                    // Write response data
                    let resp_ptr = out.response_data.as_ptr() as *mut u8;
                    unsafe { std::ptr::copy_nonoverlapping(data.as_ptr(), resp_ptr, len) };
                    out.response_data_len.store(len as u32, Ordering::Relaxed);
                    out.response_ok.store(data.len() > 0, Ordering::Relaxed);
                }
                gv_core::CMD_LOAD_STATE => {
                    let slot = inp.slot.load(Ordering::Relaxed);
                    let len = out.response_data_len.load(Ordering::Relaxed) as usize;
                    let data = &out.response_data[..len.min(gv_core::MAX_RESPONSE)];
                    let ok = core.load_state(&data);
                    out.response_ok.store(ok, Ordering::Relaxed);
                }
                gv_core::CMD_RESET => {
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
            let (fw, fh) = core.frame_size();
            let audio = core.drain_audio();
            
            let px_count = (fw as usize * fh as usize * 3).min(gv_core::MAX_PIXELS);
            unsafe {
                std::ptr::copy_nonoverlapping(
                    pixels.as_ptr(),
                    out.pixels.as_ptr() as *mut u8,
                    px_count,
                );
            }
            let audio_count = audio.len().min(gv_core::MAX_AUDIO);
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
