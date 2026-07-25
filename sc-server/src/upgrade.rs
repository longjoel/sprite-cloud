use anyhow::{Context, Result, bail};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

const RELEASE_API: &str = "https://api.github.com/repos/longjoel/sprite-cloud/releases/latest";
const RELEASE_BASE: &str = "https://github.com/longjoel/sprite-cloud/releases/download";
const BINARIES: [&str; 2] = ["sc-server", "sc-core"];

#[derive(serde::Deserialize)]
struct LatestRelease {
    tag_name: String,
}

fn release_arch() -> Result<&'static str> {
    match std::env::consts::ARCH {
        "x86_64" => Ok("x86_64"),
        "aarch64" => Ok("aarch64"),
        other => bail!("no Sprite Cloud release is available for architecture {other}"),
    }
}

fn expected_checksum(checksum_file: &str) -> Result<String> {
    let digest = checksum_file
        .split_whitespace()
        .next()
        .context("checksum file is empty")?;
    if digest.len() != 64 || !digest.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        bail!("release checksum is invalid");
    }
    Ok(digest.to_ascii_lowercase())
}

fn verify_checksum(bytes: &[u8], checksum_file: &str) -> Result<()> {
    let expected = expected_checksum(checksum_file)?;
    let actual = hex::encode(Sha256::digest(bytes));
    if actual != expected {
        bail!("release checksum mismatch: expected {expected}, got {actual}");
    }
    Ok(())
}

fn stage_binary(install_dir: &Path, name: &str, bytes: &[u8]) -> Result<PathBuf> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;

    let staged = install_dir.join(format!(".{name}.upgrade-{}", std::process::id()));
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o755)
        .open(&staged)
        .with_context(|| format!("stage {}", staged.display()))?;
    file.write_all(bytes)
        .with_context(|| format!("write {}", staged.display()))?;
    file.sync_all()
        .with_context(|| format!("sync {}", staged.display()))?;
    Ok(staged)
}

pub async fn run() -> Result<()> {
    let current_exe = std::env::current_exe().context("locate the running sc-server")?;
    let install_dir = current_exe
        .parent()
        .context("running sc-server has no parent directory")?;
    if current_exe.file_name().and_then(|name| name.to_str()) != Some("sc-server") {
        bail!("upgrade must be run from an installed sc-server executable");
    }

    let probe = install_dir.join(format!(".sc-upgrade-write-test-{}", std::process::id()));
    std::fs::write(&probe, b"").with_context(|| {
        format!(
            "{} is not writable; rerun with the account that installed sc-server",
            install_dir.display()
        )
    })?;
    std::fs::remove_file(&probe).context("remove upgrade write probe")?;

    let arch = release_arch()?;
    let http = reqwest::Client::builder()
        .user_agent("sc-server-upgrade")
        .connect_timeout(std::time::Duration::from_secs(10))
        .timeout(std::time::Duration::from_secs(60))
        .build()
        .context("build HTTP client")?;
    let latest: LatestRelease = http
        .get(RELEASE_API)
        .send()
        .await
        .context("query latest Sprite Cloud release")?
        .error_for_status()
        .context("latest release request failed")?
        .json()
        .await
        .context("parse latest Sprite Cloud release")?;

    println!("  → Upgrading to {} ({arch})", latest.tag_name);

    let mut downloads = Vec::new();
    for name in BINARIES {
        let asset = format!("{name}-{arch}");
        let url = format!("{RELEASE_BASE}/{}/{asset}", latest.tag_name);
        let bytes = http
            .get(&url)
            .send()
            .await
            .with_context(|| format!("download {asset}"))?
            .error_for_status()
            .with_context(|| format!("release does not contain {asset}"))?
            .bytes()
            .await
            .with_context(|| format!("read {asset}"))?;
        let checksum = http
            .get(format!("{url}.sha256"))
            .send()
            .await
            .with_context(|| format!("download {asset} checksum"))?
            .error_for_status()
            .with_context(|| format!("release does not contain {asset}.sha256"))?
            .text()
            .await
            .with_context(|| format!("read {asset} checksum"))?;
        verify_checksum(&bytes, &checksum).with_context(|| format!("verify {asset}"))?;
        downloads.push((name, bytes));
        println!("  ✓ Verified {asset}");
    }

    let mut staged = Vec::new();
    for (name, bytes) in &downloads {
        match stage_binary(install_dir, name, bytes) {
            Ok(path) => staged.push((*name, path)),
            Err(error) => {
                for (_, path) in &staged {
                    let _ = std::fs::remove_file(path);
                }
                return Err(error);
            }
        }
    }

    // Install the runner first. If the process is interrupted between renames,
    // the existing server can still launch games with the newer compatible runner.
    staged.sort_by_key(|(name, _)| if *name == "sc-core" { 0 } else { 1 });
    for (name, path) in staged {
        let destination = install_dir.join(name);
        std::fs::rename(&path, &destination)
            .with_context(|| format!("install {}", destination.display()))?;
        println!("  ✓ Installed {}", destination.display());
    }

    println!("\n  ✓ Sprite Cloud {} installed", latest.tag_name);
    println!("  Restart the service: systemctl --user restart sc-server");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn checksum_parser_accepts_standard_sha256_file() {
        let digest = "a".repeat(64);
        assert_eq!(
            expected_checksum(&format!("{digest}  sc-server-x86_64\n")).unwrap(),
            digest
        );
    }

    #[test]
    fn checksum_verification_rejects_wrong_digest() {
        let error = verify_checksum(b"sprite-cloud", &format!("{}  sc-server\n", "0".repeat(64)))
            .unwrap_err();
        assert!(error.to_string().contains("checksum mismatch"));
    }
}
