use anyhow::{Context, Result};
use std::io::{BufRead, Write};

use crate::config;
use crate::nat;
use crate::scan;

pub async fn run() -> Result<()> {
    let stdin = std::io::stdin();
    let mut stdout = std::io::stdout();
    let mut reader = stdin.lock();

    println!();
    println!("  ╔══════════════════════════════════════╗");
    println!("  ║     Sprite Cloud — Setup Wizard      ║");
    println!("  ╚══════════════════════════════════════╝");
    println!();
    println!("  This will configure your streaming server.");
    println!("  Press Enter to accept defaults shown in [brackets].");
    println!();

    // ── 1. ROM directory ──────────────────────────────────────────
    let default_roms = guess_rom_dir();
    print!("  ROM directory [{}]: ", default_roms);
    stdout.flush()?;
    let mut rom_dir = String::new();
    reader.read_line(&mut rom_dir)?;
    let rom_dir = rom_dir.trim().to_string();
    let rom_roots: Vec<String> = if rom_dir.is_empty() {
        if default_roms == "none" {
            Vec::new()
        } else {
            vec![default_roms]
        }
    } else {
        vec![rom_dir]
    };
    if rom_roots.is_empty() {
        println!("  → Skipped. Set later with GV_ROM_ROOTS.");
    } else {
        println!("  ✓ ROMs: {}", rom_roots[0]);
        // Quick scan to show what's there
        let mut total = 0usize;
        let mut platforms = std::collections::BTreeSet::new();
        for root in &rom_roots {
            if let Ok(files) = scan::discover_roms(std::path::Path::new(root)) {
                total += files.len();
                for f in &files {
                if let Some(platform) = &f.platform {
                    platforms.insert(platform.clone());
                }
                }
            }
        }
        if total > 0 {
            println!("  → Found {} games across {} platforms", total, platforms.len());
        } else {
            println!("  → No ROMs found yet. Add files and run: sc-server start");
        }
    }

    // ── 2. Cores directory ────────────────────────────────────────
    let default_cores = "/usr/lib/libretro";
    print!("  Libretro cores directory [{}]: ", default_cores);
    stdout.flush()?;
    let mut cores_dir = String::new();
    reader.read_line(&mut cores_dir)?;
    let cores_dir = cores_dir.trim().to_string();
    let cores_dir = if cores_dir.is_empty() {
        default_cores.to_string()
    } else {
        cores_dir
    };
    println!("  ✓ Cores: {}", cores_dir);

    // ── 3. NAT check ─────────────────────────────────────────────
    let sc_web_url = config::load()
        .ok()
        .and_then(|c| Some(c.sc_web.url))
        .unwrap_or_else(|| "https://sprite-cloud.com".to_string());

    println!();
    println!("  Checking network...");
    let detection = match nat::detect(&[
        "stun.l.google.com:19302",
        "stun1.l.google.com:19302",
    ])
    .await
    {
        Ok(d) => {
            println!(
                "  Local address:  {}",
                d.local_addr
            );
            if d.nat_type != nat::NatType::Unknown {
                println!("  Public address: {} (via STUN)", d.mapped_addr);
            }
            println!("  NAT type: {}", d.nat_type.description());
            d
        }
        Err(e) => {
            println!("  ⚠ NAT check failed: {e}");
            println!("  → Assuming symmetric (worst case)");
            nat::NatDetection {
                local_addr: std::net::SocketAddr::from(([0, 0, 0, 0], 0)),
                mapped_addr: std::net::SocketAddr::from(([0, 0, 0, 0], 0)),
                nat_type: nat::NatType::Unknown,
            }
        }
    };

    let ice_policy = detection.nat_type.recommended_policy();
    println!(
        "  → Recommended ICE policy: {}",
        ice_policy
    );
    if detection.nat_type == nat::NatType::Symmetric {
        println!("  → You'll need a TURN server for remote/mobile players.");
    }

    // ── 4. ICE policy ────────────────────────────────────────────
    print!("  ICE transport policy [{}]: ", ice_policy);
    stdout.flush()?;
    let mut policy = String::new();
    reader.read_line(&mut policy)?;
    let policy = policy.trim().to_string();
    let ice_policy = if policy.is_empty() {
        ice_policy.to_string()
    } else {
        policy
    };
    println!("  ✓ ICE policy: {}", ice_policy);

    // ── 5. STUN server ───────────────────────────────────────────
    let default_stun = "stun:stun.l.google.com:19302";
    print!("  STUN server [{}]: ", default_stun);
    stdout.flush()?;
    let mut stun = String::new();
    reader.read_line(&mut stun)?;
    let stun = stun.trim().to_string();
    let stun_url = if stun.is_empty() {
        default_stun.to_string()
    } else {
        stun
    };
    println!("  ✓ STUN: {}", stun_url);

    // ── 6. Save config ───────────────────────────────────────────
    let cfg = config::Config {
        sc_web: config::ScWeb { url: sc_web_url },
        auth: config::Auth {
            api_key: String::new(),
            server_id: String::new(),
        },
        rom: if rom_roots.is_empty() {
            None
        } else {
            Some(config::Rom {
                roots: rom_roots,
            })
        },
        cores: Some(config::Cores { dir: cores_dir }),
        ice: Some(config::Ice {
            stun_url,
            policy: ice_policy,
            turn: None,
        }),
    };

    config::save(&cfg).context("save config")?;

    println!();
    println!("  ✓ Config saved to ~/.config/sprite-cloud/config.toml");
    println!();
    println!("  Next step: pair with your account");
    println!("    sc-server pair <code> --sc-web-url {}", cfg.sc_web.url);
    println!();

    Ok(())
}

fn guess_rom_dir() -> String {
    // Common ROM root paths — check these first
    let candidates = [
        "~/roms",
        "~/ROMs",
        "~/games",
        "~/retro",
        "/home/pi/roms",
        "/home/zombie/roms",
    ];
    for c in &candidates {
        let expanded = shellexpand::tilde(c).to_string();
        if std::path::Path::new(&expanded).is_dir() {
            return expanded;
        }
    }

    // Check home directory for any dir with ROM-like subdirs
    if let Some(home) = dirs::home_dir() {
        if let Ok(entries) = std::fs::read_dir(&home) {
            for entry in entries.flatten() {
                let path = entry.path();
                if !path.is_dir() {
                    continue;
                }
                // Look for platform subdirs
                for platform in &["nes", "snes", "genesis", "gb", "gba", "n64", "psx"] {
                    if path.join(platform).is_dir() {
                        return path.to_string_lossy().to_string();
                    }
                }
            }
        }
    }

    "none".to_string()
}
