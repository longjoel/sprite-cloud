use anyhow::{Context, Result, bail};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::process::Command;

#[derive(Debug)]
pub struct ManagedRestart {
    scope: &'static str,
}

fn restartable_properties(output: &str, current_pid: u32) -> bool {
    let mut main_pid = None;
    let mut restart = None;
    for line in output.lines() {
        if let Some(value) = line.strip_prefix("MainPID=") {
            main_pid = value.parse::<u32>().ok();
        } else if let Some(value) = line.strip_prefix("Restart=") {
            restart = Some(value);
        }
    }
    main_pid == Some(current_pid) && matches!(restart, Some("on-failure" | "always"))
}

pub fn verify_managed_restart() -> Result<ManagedRestart> {
    for scope in ["user", "system"] {
        let mut command = Command::new("systemctl");
        if scope == "user" {
            command.arg("--user");
        }
        let output = command
            .args([
                "show",
                "sc-server.service",
                "--property=MainPID",
                "--property=Restart",
            ])
            .output();
        if let Ok(output) = output
            && output.status.success()
            && restartable_properties(&String::from_utf8_lossy(&output.stdout), std::process::id())
        {
            return Ok(ManagedRestart { scope });
        }
    }
    bail!(
        "dashboard updates require this process to be the main PID of sc-server.service with Restart=on-failure or Restart=always"
    );
}

impl ManagedRestart {
    pub fn schedule(self) {
        tracing::info!(
            scope = self.scope,
            "[UPGRADE] acknowledged update; exiting for managed restart"
        );
        tokio::spawn(async {
            tokio::time::sleep(std::time::Duration::from_secs(1)).await;
            std::process::exit(75);
        });
    }
}

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
    use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};

    let staged = install_dir.join(format!(".{name}.upgrade-{:016x}", rand::random::<u64>()));
    let result = (|| -> Result<()> {
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o755)
            .open(&staged)
            .with_context(|| format!("stage {}", staged.display()))?;
        file.write_all(bytes)
            .with_context(|| format!("write {}", staged.display()))?;
        file.set_permissions(std::fs::Permissions::from_mode(0o755))
            .with_context(|| format!("set executable permissions on {}", staged.display()))?;
        file.sync_all()
            .with_context(|| format!("sync {}", staged.display()))?;
        Ok(())
    })();
    if let Err(error) = result {
        let _ = std::fs::remove_file(&staged);
        return Err(error);
    }
    Ok(staged)
}

fn backup_binary(destination: &Path) -> Result<Option<PathBuf>> {
    if !destination.exists() {
        return Ok(None);
    }
    let name = destination
        .file_name()
        .and_then(|name| name.to_str())
        .context("installed binary name is not valid UTF-8")?;
    let backup =
        destination.with_file_name(format!(".{name}.backup-{:016x}", rand::random::<u64>()));
    std::fs::copy(destination, &backup)
        .with_context(|| format!("back up {}", destination.display()))?;
    Ok(Some(backup))
}

fn rollback_core(destination: &Path, backup: Option<&Path>) -> Result<()> {
    if let Some(backup) = backup {
        std::fs::rename(backup, destination)
            .with_context(|| format!("restore {}", destination.display()))?;
    } else if destination.exists() {
        std::fs::remove_file(destination)
            .with_context(|| format!("remove partially installed {}", destination.display()))?;
    }
    Ok(())
}
static PENDING_UPGRADE_SIGNAL: std::sync::atomic::AtomicI32 = std::sync::atomic::AtomicI32::new(0);

extern "C" fn defer_upgrade_signal(signal: libc::c_int) {
    use std::sync::atomic::Ordering;

    let _ = PENDING_UPGRADE_SIGNAL.compare_exchange(0, signal, Ordering::SeqCst, Ordering::SeqCst);
}

struct PreviousSignalAction {
    signal: libc::c_int,
    action: libc::sigaction,
}

struct UpgradeSignalGuard {
    previous: Vec<PreviousSignalAction>,
}

impl UpgradeSignalGuard {
    fn block() -> Result<Self> {
        use std::sync::atomic::Ordering;

        PENDING_UPGRADE_SIGNAL.store(0, Ordering::SeqCst);
        let mut previous: Vec<PreviousSignalAction> = Vec::new();
        for signal in [libc::SIGINT, libc::SIGTERM, libc::SIGHUP] {
            let mut replacement = unsafe { std::mem::zeroed::<libc::sigaction>() };
            replacement.sa_sigaction = defer_upgrade_signal as *const () as usize;
            replacement.sa_flags = libc::SA_RESTART;
            unsafe { libc::sigemptyset(&mut replacement.sa_mask) };

            let mut prior = unsafe { std::mem::zeroed::<libc::sigaction>() };
            if unsafe { libc::sigaction(signal, &replacement, &mut prior) } != 0 {
                let error = std::io::Error::last_os_error();
                for installed in previous.iter().rev() {
                    unsafe {
                        libc::sigaction(installed.signal, &installed.action, std::ptr::null_mut());
                    }
                }
                return Err(error).with_context(|| format!("defer signal {signal} during upgrade"));
            }
            previous.push(PreviousSignalAction {
                signal,
                action: prior,
            });
        }
        Ok(Self { previous })
    }
}

impl Drop for UpgradeSignalGuard {
    fn drop(&mut self) {
        use std::sync::atomic::Ordering;

        for previous in self.previous.iter().rev() {
            unsafe {
                libc::sigaction(previous.signal, &previous.action, std::ptr::null_mut());
            }
        }
        let pending = PENDING_UPGRADE_SIGNAL.swap(0, Ordering::SeqCst);
        if pending != 0 {
            unsafe {
                libc::kill(libc::getpid(), pending);
            }
        }
    }
}

fn install_staged_pair(install_dir: &Path, staged_core: &Path, staged_server: &Path) -> Result<()> {
    let _signal_guard = UpgradeSignalGuard::block()?;
    let core_destination = install_dir.join("sc-core");
    let server_destination = install_dir.join("sc-server");
    let core_backup = backup_binary(&core_destination)?;
    let server_backup = match backup_binary(&server_destination) {
        Ok(backup) => backup,
        Err(error) => {
            if let Some(path) = &core_backup {
                let _ = std::fs::remove_file(path);
            }
            return Err(error);
        }
    };

    if let Err(error) = std::fs::rename(staged_core, &core_destination) {
        if let Some(path) = &core_backup {
            let _ = std::fs::remove_file(path);
        }
        if let Some(path) = &server_backup {
            let _ = std::fs::remove_file(path);
        }
        return Err(error).with_context(|| format!("install {}", core_destination.display()));
    }

    #[cfg(test)]
    if std::env::var_os("SC_UPGRADE_PAUSE_AFTER_CORE").is_some() {
        std::thread::sleep(std::time::Duration::from_millis(200));
    }

    if let Err(error) = std::fs::rename(staged_server, &server_destination) {
        let rollback = rollback_core(&core_destination, core_backup.as_deref());
        if let Some(path) = &server_backup {
            let _ = std::fs::remove_file(path);
        }
        let _ = std::fs::remove_file(staged_server);
        rollback.context("sc-server install failed and sc-core rollback also failed")?;
        return Err(error).with_context(|| format!("install {}", server_destination.display()));
    }

    if let Some(path) = core_backup {
        let _ = std::fs::remove_file(path);
    }
    if let Some(path) = server_backup {
        let _ = std::fs::remove_file(path);
    }
    Ok(())
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

    let staged_core = staged
        .iter()
        .find(|(name, _)| *name == "sc-core")
        .map(|(_, path)| path.as_path())
        .context("sc-core was not staged")?;
    let staged_server = staged
        .iter()
        .find(|(name, _)| *name == "sc-server")
        .map(|(_, path)| path.as_path())
        .context("sc-server was not staged")?;
    install_staged_pair(install_dir, staged_core, staged_server)?;
    println!("  ✓ Installed {}", install_dir.join("sc-core").display());
    println!("  ✓ Installed {}", install_dir.join("sc-server").display());

    println!("\n  ✓ Sprite Cloud {} installed", latest.tag_name);
    println!("  Restart the service: systemctl --user restart sc-server");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::process::ExitStatusExt;

    static RESTORED_SIGNAL_COUNT: std::sync::atomic::AtomicUsize =
        std::sync::atomic::AtomicUsize::new(0);

    extern "C" fn count_restored_signal(_: libc::c_int) {
        RESTORED_SIGNAL_COUNT.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    }

    #[test]
    fn restart_preflight_requires_exact_main_pid_and_restart_policy() {
        assert!(restartable_properties(
            "MainPID=42\nRestart=on-failure\n",
            42
        ));
        assert!(restartable_properties("Restart=always\nMainPID=42\n", 42));
        assert!(!restartable_properties(
            "MainPID=41\nRestart=on-failure\n",
            42
        ));
        assert!(!restartable_properties("MainPID=42\nRestart=no\n", 42));
        assert!(!restartable_properties("", 42));
    }

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

    #[test]
    fn staged_binary_is_0755_under_restrictive_umask() {
        if std::env::var_os("SC_STAGE_UMASK_CHILD").is_some() {
            use std::os::unix::fs::PermissionsExt;
            let old_umask = unsafe { libc::umask(0o077) };
            let dir = tempfile::tempdir().unwrap();
            let staged = stage_binary(dir.path(), "sc-server", b"binary").unwrap();
            let mode = std::fs::metadata(staged).unwrap().permissions().mode() & 0o777;
            unsafe { libc::umask(old_umask) };
            assert_eq!(mode, 0o755);
            return;
        }

        let status = std::process::Command::new(std::env::current_exe().unwrap())
            .arg("--exact")
            .arg("upgrade::tests::staged_binary_is_0755_under_restrictive_umask")
            .arg("--nocapture")
            .env("SC_STAGE_UMASK_CHILD", "1")
            .status()
            .unwrap();
        assert!(status.success());
    }

    #[test]
    fn native_pair_install_restores_prior_signal_disposition() {
        if std::env::var_os("SC_UPGRADE_RESTORE_SIGNAL_CHILD").is_some() {
            RESTORED_SIGNAL_COUNT.store(0, std::sync::atomic::Ordering::SeqCst);
            let mut replacement = unsafe { std::mem::zeroed::<libc::sigaction>() };
            replacement.sa_sigaction = count_restored_signal as *const () as usize;
            unsafe { libc::sigemptyset(&mut replacement.sa_mask) };
            let mut prior = unsafe { std::mem::zeroed::<libc::sigaction>() };
            assert_eq!(
                unsafe { libc::sigaction(libc::SIGTERM, &replacement, &mut prior) },
                0
            );

            let dir = tempfile::tempdir().unwrap();
            std::fs::write(dir.path().join("sc-core"), b"old-core").unwrap();
            std::fs::write(dir.path().join("sc-server"), b"old-server").unwrap();
            let staged_core = dir.path().join(".staged-core");
            let staged_server = dir.path().join(".staged-server");
            std::fs::write(&staged_core, b"new-core").unwrap();
            std::fs::write(&staged_server, b"new-server").unwrap();

            install_staged_pair(dir.path(), &staged_core, &staged_server).unwrap();
            unsafe { libc::kill(libc::getpid(), libc::SIGTERM) };
            for _ in 0..100 {
                if RESTORED_SIGNAL_COUNT.load(std::sync::atomic::Ordering::SeqCst) != 0 {
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(1));
            }
            assert_eq!(
                RESTORED_SIGNAL_COUNT.load(std::sync::atomic::Ordering::SeqCst),
                1
            );
            unsafe { libc::sigaction(libc::SIGTERM, &prior, std::ptr::null_mut()) };
            return;
        }

        let status = std::process::Command::new(std::env::current_exe().unwrap())
            .arg("--exact")
            .arg("upgrade::tests::native_pair_install_restores_prior_signal_disposition")
            .arg("--nocapture")
            .env("SC_UPGRADE_RESTORE_SIGNAL_CHILD", "1")
            .status()
            .unwrap();
        assert!(status.success(), "child failed with {status}");
    }

    #[test]
    fn native_pair_install_defers_termination_until_both_replacements_finish() {
        if std::env::var_os("SC_UPGRADE_SIGNAL_CHILD").is_some() {
            let dir = PathBuf::from(std::env::var_os("SC_UPGRADE_SIGNAL_DIR").unwrap());
            let core = dir.join("sc-core");
            let server = dir.join("sc-server");
            let staged_core = dir.join("staged-core");
            let staged_server = dir.join("staged-server");
            std::fs::write(&core, b"old-core").unwrap();
            std::fs::write(&server, b"old-server").unwrap();
            std::fs::write(&staged_core, b"new-core").unwrap();
            std::fs::write(&staged_server, b"new-server").unwrap();

            std::thread::spawn(|| {
                std::thread::sleep(std::time::Duration::from_millis(50));
                unsafe { libc::kill(libc::getpid(), libc::SIGTERM) };
            });
            install_staged_pair(&dir, &staged_core, &staged_server).unwrap();
            panic!("pending SIGTERM should be delivered when the transaction guard drops");
        }

        let dir = tempfile::tempdir().unwrap();
        let status = std::process::Command::new(std::env::current_exe().unwrap())
            .arg("--exact")
            .arg(
                "upgrade::tests::native_pair_install_defers_termination_until_both_replacements_finish",
            )
            .arg("--nocapture")
            .env("SC_UPGRADE_SIGNAL_CHILD", "1")
            .env("SC_UPGRADE_SIGNAL_DIR", dir.path())
            .env("SC_UPGRADE_PAUSE_AFTER_CORE", "1")
            .status()
            .unwrap();

        assert_eq!(status.signal(), Some(libc::SIGTERM));
        assert_eq!(
            std::fs::read(dir.path().join("sc-core")).unwrap(),
            b"new-core"
        );
        assert_eq!(
            std::fs::read(dir.path().join("sc-server")).unwrap(),
            b"new-server"
        );
    }

    #[test]
    fn pair_install_rolls_core_back_when_server_replace_fails() {
        let dir = tempfile::tempdir().unwrap();
        let core = dir.path().join("sc-core");
        let server = dir.path().join("sc-server");
        let staged_core = dir.path().join("staged-core");
        let missing_server = dir.path().join("missing-server");
        std::fs::write(&core, b"old-core").unwrap();
        std::fs::write(&server, b"old-server").unwrap();
        std::fs::write(&staged_core, b"new-core").unwrap();

        let error = install_staged_pair(dir.path(), &staged_core, &missing_server).unwrap_err();

        assert!(error.to_string().contains("install"));
        assert_eq!(std::fs::read(&core).unwrap(), b"old-core");
        assert_eq!(std::fs::read(&server).unwrap(), b"old-server");
    }

    #[test]
    fn pair_install_replaces_both_binaries() {
        let dir = tempfile::tempdir().unwrap();
        let core = dir.path().join("sc-core");
        let server = dir.path().join("sc-server");
        let staged_core = dir.path().join("staged-core");
        let staged_server = dir.path().join("staged-server");
        std::fs::write(&core, b"old-core").unwrap();
        std::fs::write(&server, b"old-server").unwrap();
        std::fs::write(&staged_core, b"new-core").unwrap();
        std::fs::write(&staged_server, b"new-server").unwrap();

        install_staged_pair(dir.path(), &staged_core, &staged_server).unwrap();

        assert_eq!(std::fs::read(&core).unwrap(), b"new-core");
        assert_eq!(std::fs::read(&server).unwrap(), b"new-server");
    }
}
