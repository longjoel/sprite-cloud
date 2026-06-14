# ADR 015: Worker deployment model

**Status:** Proposed
**Date:** 2026-06-14

## Context

gv-server spawns gv-worker as a child process on the same machine.
This is simple but limits scale — all game processing happens on one box.

## Options

### A: Same-machine (current model)
- gv-server calls `Command::new("gv-worker").spawn()`
- Workers share CPU/GPU with the server
- **Effort:** Zero — already works
- **Limit:** One machine's CPU/GPU capacity

### B: Docker containers per worker
- gv-server spawns workers via Docker SDK
- Resource isolation (CPU/memory limits per game)
- GPU passthrough needed for hardware encoding
- **Effort:** Medium

### C: Remote workers (SSH/k8s)
- gv-server spawns workers on separate machines via SSH or Kubernetes
- Horizontal scale — more games = more machines
- Network latency between server and worker adds overhead
- **Effort:** High

## Decision

**Option A for MVP.** Same-machine child processes. Revisit when a
single machine can't handle the game load. The binary-path resolution
(`GV_WORKER_BIN` env var) already supports different paths per deployment,
making a future migration to Docker or remote workers straightforward.

## Consequences

- Worker port range: dynamic (0 = random). Firewall must allow ephemeral
  ports on the LAN interface.
- CPU contention: multiple workers compete for CPU. VP8 encoding is
  single-threaded per worker — a quad-core machine can handle 2–3
  concurrent games comfortably.
- GPU encoding (NVENC, VAAPI) would reduce CPU load per worker but
  requires GPU access from the worker process.
