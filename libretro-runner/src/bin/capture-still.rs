//! One-shot, process-bounded libretro still capture.
//!
//! Usage: capture-still <core.so> <output.png> <system-dir> <frames> <timeout-ms> [rom|-]

use std::env;
use std::path::PathBuf;
use std::process::{Command, ExitCode};
use std::thread;
use std::time::{Duration, Instant};

use libretro_runner::{capture_still, CaptureConfig};

fn usage() -> ! {
    eprintln!("usage: capture-still <core.so> <output.png> <system-dir> <frames> <timeout-ms> [rom|-]");
    std::process::exit(64);
}

fn parse_args() -> (PathBuf, PathBuf, PathBuf, u32, Duration, Option<PathBuf>) {
    let mut args = env::args_os();
    let _program = args.next();
    let first = args.next().unwrap_or_else(|| usage());
    let core = if first == "--worker" {
        args.next().map(PathBuf::from).unwrap_or_else(|| usage())
    } else {
        PathBuf::from(first)
    };
    let output = args.next().map(PathBuf::from).unwrap_or_else(|| usage());
    let system = args.next().map(PathBuf::from).unwrap_or_else(|| usage());
    let frames = args
        .next()
        .and_then(|value| value.into_string().ok())
        .and_then(|value| value.parse().ok())
        .filter(|&value| value > 0)
        .unwrap_or_else(|| usage());
    let timeout = args
        .next()
        .and_then(|value| value.into_string().ok())
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|&value| value > 0)
        .map(Duration::from_millis)
        .unwrap_or_else(|| usage());
    let rom = args.next().and_then(|value| {
        if value == "-" { None } else { Some(PathBuf::from(value)) }
    });
    if args.next().is_some() { usage(); }
    (core, output, system, frames, timeout, rom)
}

fn worker() -> ExitCode {
    let (core, output, system, frames, timeout, rom) = parse_args();
    match capture_still(CaptureConfig {
        core_path: core,
        content_path: rom,
        system_dir: system,
        output_path: output,
        frame_budget: frames,
        max_wall_time: timeout,
    }) {
        Ok(captured) => { println!("{} {}x{} frame={}", captured.path.display(), captured.width, captured.height, captured.source_frame); ExitCode::SUCCESS }
        Err(error) => { eprintln!("capture failed: {error}"); ExitCode::from(1) }
    }
}

fn controller() -> ExitCode {
    let raw: Vec<_> = env::args_os().skip(1).collect();
    let timeout_ms = raw.get(4).and_then(|value| value.to_str()).and_then(|value| value.parse::<u64>().ok()).filter(|&value| value > 0).unwrap_or_else(|| usage());
    let deadline = Duration::from_millis(timeout_ms);
    let executable = env::current_exe().unwrap_or_else(|error| { eprintln!("capture failed: current executable: {error}"); std::process::exit(1) });
    let mut child = Command::new(executable).arg("--worker").args(&raw).spawn().unwrap_or_else(|error| { eprintln!("capture failed: spawn worker: {error}"); std::process::exit(1) });
    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return if status.success() { ExitCode::SUCCESS } else { ExitCode::from(1) },
            Ok(None) if started.elapsed() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                eprintln!("capture failed: worker exceeded {deadline:?}");
                return ExitCode::from(124);
            }
            Ok(None) => thread::sleep(Duration::from_millis(5)),
            Err(error) => { eprintln!("capture failed: wait worker: {error}"); return ExitCode::from(1); }
        }
    }
}

fn main() -> ExitCode {
    if env::args_os().nth(1).as_deref() == Some(std::ffi::OsStr::new("--worker")) {
        let mut args: Vec<_> = env::args_os().collect();
        args.remove(1);
        // Re-exec is avoided: worker parses the original positional suffix directly below.
        return worker_from(args);
    }
    controller()
}

fn worker_from(args: Vec<std::ffi::OsString>) -> ExitCode {
    let _ = args;
    worker()
}
