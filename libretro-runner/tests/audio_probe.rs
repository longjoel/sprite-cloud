//! Audio channel probe — loads a real libretro core + ROM and measures
//! per-channel energy of the drained audio.
//!
//! This is the evidence harness for #686 (NES mono audio one-sided) and the
//! mono-platform audit. It answers: does this core output identical L/R
//! (correct mono duplication), or one silent channel?
//!
//! Env:
//!   TEST_LIBRETRO_CORE — path to a libretro .so
//!   TEST_LIBRETRO_ROM  — path to a ROM that produces audio (e.g. tone.nes)
//!
//! Run:
//!   TEST_LIBRETRO_CORE=... TEST_LIBRETRO_ROM=... cargo test -p libretro-runner --test audio_probe -- --nocapture

use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

use libretro_runner::{Core, CoreConfig};

fn libretro_test_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

fn env_path(name: &str) -> Option<PathBuf> {
    std::env::var(name).ok().map(PathBuf::from)
}

struct ChannelStats {
    frames: u64,
    pairs: u64,
    sum_l: i128,
    sum_r: i128,
    unequal_pairs: u64,
    nonzero_l: u64,
    nonzero_r: u64,
}

fn analyze(samples: &[i16]) -> ChannelStats {
    let mut stats = ChannelStats {
        frames: 0,
        pairs: 0,
        sum_l: 0,
        sum_r: 0,
        unequal_pairs: 0,
        nonzero_l: 0,
        nonzero_r: 0,
    };
    for pair in samples.as_chunks::<2>().0 {
        let l = pair[0] as i64;
        let r = pair[1] as i64;
        stats.pairs += 1;
        stats.sum_l += (l as i128).abs();
        stats.sum_r += (r as i128).abs();
        if l != r {
            stats.unequal_pairs += 1;
        }
        if l != 0 {
            stats.nonzero_l += 1;
        }
        if r != 0 {
            stats.nonzero_r += 1;
        }
    }
    stats
}

#[test]
fn probe_audio_channels() {
    let _guard = libretro_test_lock().lock().unwrap();

    let core_path = match env_path("TEST_LIBRETRO_CORE") {
        Some(p) => p,
        None => {
            eprintln!("SKIP: TEST_LIBRETRO_CORE not set");
            return;
        }
    };
    let rom_path = env_path("TEST_LIBRETRO_ROM");
    if let Some(ref p) = rom_path
        && !p.exists()
    {
        eprintln!("SKIP: ROM missing: {}", p.display());
        return;
    }
    if !core_path.exists() {
        eprintln!("SKIP: core missing: {}", core_path.display());
        return;
    }

    // SAFETY: cores are trusted libretro implementations from the platform manifest.
    let mut core = unsafe {
        Core::load(CoreConfig {
            core_path: core_path.clone(),
            content_path: rom_path.clone(),
            system_dir: "/tmp".into(),
            save_dir: "/tmp".into(),
            audio_channels: 2,
            mono: false,
        })
    }
    .unwrap_or_else(|e| panic!("failed to load core {}: {e}", core_path.display()));

    let sample_rate = core.av_info.sample_rate;
    let mut total = ChannelStats {
        frames: 0,
        pairs: 0,
        sum_l: 0,
        sum_r: 0,
        unequal_pairs: 0,
        nonzero_l: 0,
        nonzero_r: 0,
    };

    // Run 150 frames; the tone ROM produces audio from the first frame.
    for _ in 0..150 {
        let _ = core.run_frame();
        let samples = core.drain_audio();
        if samples.is_empty() {
            continue;
        }
        let s = analyze(&samples);
        total.frames += 1;
        total.pairs += s.pairs;
        total.sum_l += s.sum_l;
        total.sum_r += s.sum_r;
        total.unequal_pairs += s.unequal_pairs;
        total.nonzero_l += s.nonzero_l;
        total.nonzero_r += s.nonzero_r;
    }

    let core_name = core_path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("?")
        .to_string();

    eprintln!(
        "[PROBE] core={core_name} rom={} rate={sample_rate:.0}Hz frames_with_audio={} pairs={}",
        rom_path.as_ref().map(|p| p.display().to_string()).unwrap_or_else(|| "<none>".into()),
        total.frames,
        total.pairs
    );
    eprintln!(
        "[PROBE] energy L={} R={} | nonzero L={} R={} | unequal_pairs={}",
        total.sum_l, total.sum_r, total.nonzero_l, total.nonzero_r, total.unequal_pairs
    );

    let rom_provided = rom_path.is_some();

    if total.pairs == 0 {
        if rom_provided {
            eprintln!("[PROBE] FAIL: ROM produced no audio at all");
            panic!("no audio from core with a ROM loaded");
        }
        eprintln!("[PROBE] NO AUDIO — no ROM, core produced no samples");
        return;
    }

    // Fail-closed: a tone ROM must produce real signal in BOTH channels.
    // An all-zero result means the fixture did not boot or the core muted —
    // that is NOT a pass, it is a broken test.
    if rom_provided && total.nonzero_l == 0 && total.nonzero_r == 0 {
        eprintln!("[PROBE] FAIL: silent audio — fixture did not boot or core muted");
        panic!("silent audio with a tone ROM loaded");
    }

    let l_dead = total.nonzero_l == 0 && total.nonzero_r > 0;
    let r_dead = total.nonzero_r == 0 && total.nonzero_l > 0;
    let balanced = total.unequal_pairs == 0;
    // Strict mode (CI): mono-platform tone ROMs must have identical channels.
    let strict = std::env::var("TEST_AUDIO_STRICT").is_ok_and(|v| v == "1");

    if l_dead || r_dead {
        let dead = if l_dead { "L" } else { "R" };
        eprintln!("[PROBE] FAIL: one-sided audio — {dead} channel is silent");
        panic!("one-sided audio detected: {dead} silent");
    }
    if !balanced {
        eprintln!(
            "[PROBE] {}: {} pairs differ (channels not identical)",
            if strict { "FAIL" } else { "WARN" },
            total.unequal_pairs
        );
        if strict {
            panic!("channels differ in strict mode");
        }
    } else {
        eprintln!("[PROBE] OK: channels identical (correct mono duplication)");
    }
}
