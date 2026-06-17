# ADR 001: Single Binary Distribution with Subcommand Dispatch

**Status:** Proposed
**Date:** 2026-06-17

## Context

Games Vault currently ships as two separate Rust binaries:

- `gv-server` — API, WebRTC signaling, worker lifecycle management
- `gv-worker` — emulator host, libretro core loader, VP8 encoder, WebRTC data plane

`gv-server` spawns `gv-worker` as a subprocess via `std::process::Command`. This requires distributing and version-matching two files.

For self-hosted deployments (user runs gv-server on their LAN machine, web UI lives on lngnckr.tech), a single-file distribution is dramatically simpler: one download, one systemd unit, one `curl | sh` install.

## Decision

Ship a **single binary** with subcommand dispatch, following the Busybox model:

```
gv-server serve    # API + signaling + worker lifecycle (current gv-server)
gv-server worker   # emulator host (current gv-worker)
```

Internally, `serve` spawns workers via:

```rust
Command::new(std::env::current_exe()?)
    .arg("worker")
    .args(worker_args)
    .spawn()
```

The worker remains a **separate process** — if an emulator core crashes, it takes down only that worker, not the server. Process isolation is preserved unchanged.

The crates stay separate in the monorepo (`gv-server/`, `gv-worker/`). The entry point dispatches:

```rust
// gv-server/src/main.rs (or a new root binary)
fn main() {
    match std::env::args().nth(1).as_deref() {
        Some("worker") => gv_worker::run(),
        _              => gv_server::run(),
    }
}
```

## Alternatives considered

### A) Merge worker into server as a library, run in-process
- Simpler dispatch, no subprocess management
- **Rejected:** emulator crash takes down the server. Core segfaults are real — process isolation matters.

### B) Keep two binaries, distribute a tarball
- No code changes
- **Rejected:** two files to version-match, two systemd units, more surface for user error. Friction kills adoption.

### C) Embed worker as a library, spawn via `tokio::process::Command` calling internal functions
- Same binary, same isolation
- **Rejected:** complexity. Subcommand dispatch is simpler and already proven (Busybox, git, docker, cargo).

## Consequences

- One binary to build, sign, and distribute per architecture
- `cargo build -p gv-server` produces the single distributable
- Installation script downloads one file, symlinks if desired
- Development workflow unchanged — crates remain separate
- Binary size increases slightly (~13MB vs ~23MB for two separate binaries due to shared dependencies)
