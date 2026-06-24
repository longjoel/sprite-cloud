//! gv-worker process management.
//!
//! Spawns gv-worker as a child process, reads the bound port from
//! stderr, and returns the URL the browser should connect to.
//!
//! # Crash recovery
//!
//! Every spawned worker writes a PID file to `/tmp/gv-workers/<game_id>.pid`.
//! `kill()` removes it on clean shutdown.  If the server crashes (SIGKILL,
//! OOM, power loss), `reap_stale_workers()` on the next startup finds and
//! kills orphaned processes.

#[cfg(test)]
use tokio::process::Command;

// ── Core mapping ──────────────────────────────────────────────────────

mod core;
mod pid;
mod spawn;

pub(crate) use pid::{internal_worker_url, reap_stale_workers};
#[cfg(test)]
pub(crate) use pid::{pid_path, write_pid_file};
pub(crate) use spawn::{SpawnedWorker, resolve_worker_bin, spawn_worker};

// ── Tests ──────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    /// `kill()` on a SpawnedWorker must terminate the child and remove the PID file.
    #[tokio::test]
    async fn kill_terminates_child_and_removes_pid_file() {
        let game_id = "test-kill-1";
        let child = Command::new("sleep")
            .arg("60")
            .spawn()
            .expect("spawn sleep");

        let pid = child.id().expect("child has pid");

        // Write a PID file manually (simulating what spawn_worker does)
        write_pid_file(game_id, pid);

        let worker = SpawnedWorker {
            url: "http://localhost:9999".into(),
            control_token: "test-control-token".into(),
            game_id: game_id.into(),
            host_token: None,
            child: Some(child),
        };

        worker.kill().await;

        // Give the OS a moment to reap
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;

        assert!(!is_process_alive(pid), "process should be dead");
        assert!(
            !pid_path(game_id).exists(),
            "PID file should be removed after kill()"
        );
    }

    /// `reap_stale_workers()` must kill gv-worker processes with PID files still present.
    #[tokio::test]
    async fn reap_kills_stale_worker() {
        let game_id = "test-reap-1";
        let tmp = tempfile::tempdir().expect("tempdir");
        let fake_worker = tmp.path().join("gv-worker");
        std::os::unix::fs::symlink("/bin/sleep", &fake_worker).expect("symlink fake gv-worker");
        let child = Command::new(&fake_worker)
            .arg("60")
            .spawn()
            .expect("spawn fake gv-worker");

        let pid = child.id().expect("child has pid");

        write_pid_file(game_id, pid);

        // Drop the child handle — we're simulating a crash where the handle is lost.
        drop(child);

        reap_stale_workers();

        tokio::time::sleep(std::time::Duration::from_millis(600)).await;

        assert!(
            !is_process_alive(pid),
            "stale gv-worker should be killed by reaper"
        );
        assert!(
            !pid_path(game_id).exists(),
            "PID file should be removed by reaper"
        );
    }

    /// `reap_stale_workers()` must clean up PID files for already-dead processes.
    #[tokio::test]
    async fn reap_removes_stale_pid_file_for_dead_process() {
        let game_id = "test-reap-dead";
        let pid = 99999; // almost certainly not running

        write_pid_file(game_id, pid);

        reap_stale_workers();

        assert!(
            !pid_path(game_id).exists(),
            "PID file for dead process should be removed"
        );
    }

    /// Dropping a SpawnedWorker is a last-ditch cleanup path: it force-kills
    /// the child and removes the PID file if callers forgot `kill()`.
    #[tokio::test]
    async fn drop_kills_child_and_removes_pid_file() {
        let game_id = "test-drop-orphan";
        let child = Command::new("sleep")
            .arg("60")
            .spawn()
            .expect("spawn sleep");

        let pid = child.id().expect("child has pid");

        write_pid_file(game_id, pid);

        let worker = SpawnedWorker {
            url: "http://localhost:9999".into(),
            control_token: "test-control-token".into(),
            game_id: game_id.into(),
            host_token: None,
            child: Some(child),
        };

        drop(worker);

        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        assert!(
            !pid_path(game_id).exists(),
            "PID file should be removed on drop"
        );
        assert!(!is_process_alive(pid), "process should be killed on drop");
    }

    /// Check whether a process with `pid` is still running.
    fn is_process_alive(pid: u32) -> bool {
        unsafe { libc::kill(pid as i32, 0) == 0 }
    }

    // ── resolve_worker_bin tests ───────────────────────────────────

    /// config.toml override wins over everything.
    #[test]
    fn override_wins() {
        let path = resolve_worker_bin(Some("/opt/gv-worker"));
        assert_eq!(path, "/opt/gv-worker");
    }

    /// GV_WORKER_BIN env var wins over auto-detect.
    #[test]
    fn env_var_wins_over_auto_detect() {
        unsafe { std::env::set_var("GV_WORKER_BIN", "/tmp/test-gv-worker") };
        let path = resolve_worker_bin(None);
        assert_eq!(path, "/tmp/test-gv-worker");
        unsafe { std::env::remove_var("GV_WORKER_BIN") };
    }

    /// Auto-detect returns a valid path (dev build).
    #[test]
    fn auto_detect_returns_valid_path() {
        unsafe { std::env::remove_var("GV_WORKER_BIN") };
        let path = resolve_worker_bin(None);
        assert!(
            path == "./target/release/gv-worker"
                || path == "./target/debug/gv-worker",
            "expected release/debug path, got: {path}"
        );
    }

    // ── Core mapping table coverage ───────────────────────────────

    /// Every platform in the manifest that has extensions must have a
    /// core mapping (validates no accidental empty cores).
    #[test]
    fn every_scan_platform_has_core_mapping() {
        use crate::platform::PLATFORMS;

        let platforms: std::collections::HashSet<&str> =
            PLATFORMS.iter().map(|p| p.short_name).collect();

        let missing: Vec<_> = platforms
            .iter()
            .filter(|p| core_for_platform(p).is_none())
            .collect();

        assert!(
            missing.is_empty(),
            "PLATFORMS short_names without core mappings: {missing:?}"
        );
    }

    /// Full RetroArch DAT platform names covered.
    #[test]
    fn retroarch_dat_platforms_have_core_mapping() {
        let dat_platforms = &[
            "Nintendo - Game Boy",
            "Nintendo - Game Boy Color",
            "Nintendo - Game Boy Advance",
            "Nintendo - Nintendo Entertainment System",
            "Nintendo - Family Computer Disk System",
            "Nintendo - Super Nintendo Entertainment System",
            "Nintendo - Nintendo 64",
            "Nintendo - Nintendo DS",
            "Nintendo - Virtual Boy",
            "Nintendo - Pokemon Mini",
            "Sega - Mega Drive - Genesis",
            "Sega - Master System - Mark III",
            "Sega - Game Gear",
            "Sega - Sega CD - Mega CD",
            "Sega - Sega 32X",
            "Sega - Saturn",
            "Sega - Dreamcast",
            "Sony - PlayStation",
            "Sony - PlayStation Portable",
            "Atari - 2600",
            "Atari - 5200",
            "Atari - 7800",
            "Atari - Lynx",
            "NEC - PC Engine - TurboGrafx-16",
            "NEC - PC Engine CD - TurboGrafx-CD",
            "SNK - Neo Geo Pocket",
            "SNK - Neo Geo Pocket Color",
            "SNK - Neo Geo CD",
            "Bandai - WonderSwan",
            "Bandai - WonderSwan Color",
            "Arcade",
        ];

        let missing: Vec<_> = dat_platforms
            .iter()
            .filter(|p| core_for_platform(p).is_none())
            .collect();

        assert!(
            missing.is_empty(),
            "DAT platforms without core mappings: {missing:?}"
        );
    }

    /// First-match-wins: "Game Boy Advance" must not match "Game Boy".
    #[test]
    fn specific_platform_matches_before_broad() {
        assert_eq!(
            core_for_platform("Game Boy Advance"),
            Some("mgba_libretro.so")
        );
        assert_eq!(core_for_platform("Game Boy"), Some("mgba_libretro.so"));
    }
}
