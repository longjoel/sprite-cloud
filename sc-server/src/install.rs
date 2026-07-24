use anyhow::{Context, Result};

/// Install sc-server as a systemd user service (Linux only).
pub fn run() -> Result<()> {
    if unsafe { libc::geteuid() } == 0 {
        anyhow::bail!(
            "sc-server install creates a user service and must run as your login user, not root. \
             Re-run without sudo, then use: systemctl --user enable --now sc-server"
        );
    }

    let data_dir = dirs::data_local_dir()
        .context("no local data dir")?
        .join("sprite-cloud");
    std::fs::create_dir_all(&data_dir).context("create local data dir")?;
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
Environment="GV_DATA_DIR={data_dir}"

[Install]
WantedBy=default.target
"#,
        exe = std::env::current_exe()
            .context("detect binary path")?
            .display(),
        data_dir = data_dir.display(),
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
    println!("  Enable and start (as your login user; do not use sudo):");
    println!("    systemctl --user daemon-reload");
    println!("    systemctl --user enable --now sc-server");
    println!();
    println!("  Check status:");
    println!("    systemctl --user status sc-server");
    println!();
    println!("  Note: user services require a lingering session if headless.");
    println!("    sudo loginctl enable-linger $USER");

    Ok(())
}
