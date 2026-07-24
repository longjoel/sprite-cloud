use anyhow::{Context, Result};
use std::path::Path;

use crate::config;
use crate::scan;

/// CLI: `sc-server scan` — discover ROMs and print results.
pub async fn run(upload: bool) -> Result<()> {
    let cfg = config::load().context(
        "No config found — run 'sc-server setup' first",
    )?;

    // ROM roots: config first, then env var fallback
    let rom_roots: Vec<String> = cfg
        .rom
        .as_ref()
        .map(|r| r.roots.clone())
        .filter(|roots| !roots.is_empty())
        .unwrap_or_else(|| {
            std::env::var("GV_ROM_ROOTS")
                .ok()
                .map(|s| {
                    s.split(',')
                        .map(|p| p.trim().to_string())
                        .filter(|p| !p.is_empty())
                        .collect()
                })
                .unwrap_or_default()
        });

    if rom_roots.is_empty() {
        anyhow::bail!(
            "No ROM roots configured.\n\
             Set them in ~/.config/sprite-cloud/config.toml:\n\
             \n  [rom]\n  roots = [\"/path/to/roms\"]\n\
             \n  Or export GV_ROM_ROOTS=/path/to/roms"
        );
    }

    println!("ROM roots:");
    for root in &rom_roots {
        println!("  {}", root);
    }
    println!();

    let mut total = 0usize;
    let mut platforms = std::collections::BTreeMap::new();

    for root in &rom_roots {
        let path = Path::new(root);
        if !path.is_dir() {
            println!("  ⚠  {} — directory not found, skipping", root);
            continue;
        }

        let files = scan::discover_roms(path).context("scan failed")?;
        println!("  {} — {} files", root, files.len());

        for f in &files {
            total += 1;
            let plat = f.platform.as_deref().unwrap_or("unknown");
            platforms.entry(plat.to_string())
                .and_modify(|c| *c += 1)
                .or_insert(1usize);
        }
    }

    println!();
    println!("Total: {} games across {} platforms", total, platforms.len());
    for (plat, count) in &platforms {
        println!("  {:>4}  {}", count, plat);
    }

    if total == 0 {
        println!();
        println!("No ROM files found. Check your ROM roots and file formats.");
        return Ok(());
    }

    // Upload to sc-web if paired and --upload flag is set
    if upload {
        let client = crate::sc_web::ScWebClient::new(
            cfg.sc_web.url.clone(),
            cfg.auth.clone(),
        );

        tracing::info!("Uploading scan results...");
        let metadata = crate::commands::collect_metadata(&cfg, true).await;
        match client.verify_with_metadata(&metadata).await {
            Ok(_) => tracing::info!("Connected to sc-web"),
            Err(e) => anyhow::bail!("Cannot reach sc-web — pair first: {e}"),
        }
    }

    Ok(())
}
