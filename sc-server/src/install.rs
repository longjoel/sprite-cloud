use anyhow::{Context, Result};

/// Install sc-server as a systemd user service (Linux only).
pub fn run() -> Result<()> {
    let unit = format!(
        r#"[Unit]
Description=Sprite Cloud server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart={exe} start
Restart=on-failure
RestartSec=10
Environment=RUST_LOG=info

[Install]
WantedBy=default.target
"#,
        exe = std::env::current_exe()
            .context("detect binary path")?
            .display(),
    );

    let dir = dirs::config_dir()
        .context("no config dir")?
        .join("systemd")
        .join("user");
    std::fs::create_dir_all(&dir).context("create systemd user dir")?;
    let path = dir.join("sc-server.service");
    std::fs::write(&path, unit).context("write service file")?;

    println!("  ✓ Service installed: {}", path.display());
    println!();
    println!("  Enable and start:");
    println!("    systemctl --user enable sc-server");
    println!("    systemctl --user start sc-server");
    println!();
    println!("  Check status:");
    println!("    systemctl --user status sc-server");
    println!();
    println!("  Note: user services require a lingering session if headless.");
    println!("    sudo loginctl enable-linger $USER");

    Ok(())
}
