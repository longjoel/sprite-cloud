# Games Vault v2 — Cross-Cutting Security & Architecture Audit

**Date:** 2026-06-16
**Scope:** Full monorepo — gv-web, gv-server, gv-worker, deployment scripts, protocol docs
**Methodology:** Static analysis of all source files, config files, protocol docs, and deployment scripts

---

## Summary

| Severity | Count | Description |
|----------|-------|-------------|
| [CRITICAL] | 4 | Remote-exploitable vulnerabilities or complete auth bypasses |
| [HIGH] | 5 | Significant risk requiring near-term remediation |
| [MEDIUM] | 5 | Non-critical issues, hardening opportunities |
| [LOW] | 3 | Minor issues, documentation mismatches |

---

## [CRITICAL] Findings

### C1 — Permissive CORS on gv-worker Exposes WebRTC Endpoint
`gv-worker/src/main.rs:1313`

```rust
.layer(CorsLayer::permissive())
```

The `CorsLayer::permissive()` allows **any origin** to make requests. Combined with gv-server overriding `GV_BIND_ADDR=0.0.0.0` at spawn time (worker.rs:522), gv-worker is reachable from the LAN and potentially the internet. Any website can craft a `POST /sdp` to start a WebRTC session and receive the VP8 video stream.

The `allowed_origins()` function in `gv-worker/src/config.rs:128-152` exists but is **never called** — it's dead code annotated `#[allow(dead_code)]`. The actual CORS layer on line 1313 ignores it entirely.

**Impact:** Drive-by WebRTC hijack — any website can connect to a running worker, receive the game stream, and if the host_token is known (or absent), take full control including save/load states.

**Fix:** Replace `CorsLayer::permissive()` with `CorsLayer::new()` configured from `allowed_origins()`. Additionally, require the `ALLOWED_ORIGIN` env var in production (fail startup if unset and not in dev mode).

---

### C2 — ROM Path Traversal via `rom_path` in start_game Handler
`gv-server/src/main.rs:189-203`

```rust
let rom_path = cmd.payload.get("rom_path")
    .and_then(|v| v.as_str())
    .and_then(|rel| {
        for root in &rom_roots {
            let full = std::path::Path::new(root).join(rel);
            if full.exists() {
                return Some(full.to_string_lossy().to_string());
            }
        }
        ...
    });
```

This uses `Path::new(root).join(rel)` **without canonicalization or path traversal guards**. A malicious `rom_path` like `../../etc/passwd` or a symlink escape will resolve outside the ROM root. The `exists()` check is at the joined path — it validates existence but **not containment**.

The project already has a correct implementation in `scan.rs:83-110` (`resolve_within_roots()`) that canonicalizes and verifies prefix containment. However, it is **not used** in the start_game code path.

**Impact:** An attacker who can influence the `rom_path` field in the database (via a crafted library import or direct DB access) can force gv-worker to load **any file on the filesystem** as a "ROM". Arbitrary file read via the emulator core's ROM loading mechanism.

**Fix:** Replace the inline path resolution with a call to `scan::resolve_within_roots()`:
```rust
let rom_path = cmd.payload.get("rom_path")
    .and_then(|v| v.as_str())
    .and_then(|rel| {
        match scan::resolve_within_roots(std::path::Path::new(rel), &rom_roots) {
            Ok(full) => Some(full.to_string_lossy().to_string()),
            Err(e) => { tracing::warn!("[POLL] rom_path rejected: {e:#}"); None }
        }
    });
```

---

### C3 — Worker Token Auth Bypass: GET /api/server/notify Has No Auth
`gv-web/app/api/server/notify/route.ts:92-133`

```typescript
export async function GET(request: NextRequest) {
  const serverId = request.nextUrl.searchParams.get("server_id");
  // ...
  const workerToken = request.nextUrl.searchParams.get("worker_token");
  // No auth() call, no session check!
```

The GET handler for `/api/server/notify` performs **no authentication whatsoever**. It only checks that `server_id` and `worker_token` query params are present. This contradicts:
- **PROTOCOL.md line 21:** "Browser ── OAuth session ──→ gv-web (full user auth)"
- **API.md line 239:** "Auth: OAuth session"

ADR 002 intentionally removed auth from this endpoint ("No OAuth session cookie needed for the notify GET"). But this means the only protection is the `worker_token` — a 32-hex-char random string. If an attacker learns the token, they can retrieve the worker URL and connect to the game.

**Impact:** Token-guessing is impractical (2^128 space), but tokens are leaked through multiple channels (see C4 below). Combined with C4, this is a practical attack vector.

**Fix:** Re-add the OAuth session check for the GET handler. ADR 002's "no auth" design was for dev convenience — in production, the session cookie should be required. Alternatively, add rate-limiting on worker_token attempts.

---

### C4 — worker_token Leakage via URL Query Parameters
`gv-web/app/api/server/notify/route.ts:98`

The worker_token is passed as a URL query parameter:
```
GET /api/server/notify?server_id=X&worker_token=tok_abc123
```

Tokens in URLs leak to:
- **Browser history** (persisted on disk)
- **Server access logs** (nginx, Traefik, Next.js logs)
- **Referrer headers** (if the page loads external resources)
- **Proxy logs** (corporate proxies, CDNs)
- **Bookmarks and shared links**

**Impact:** Anyone with access to server logs or the user's browser history can hijack active game sessions by retrieving the worker URL.

**Fix:** Pass `worker_token` as an HTTP header (`X-Worker-Token`) or in the request body (POST instead of GET). Alternatively, store it in a short-lived HTTP-only cookie set at command creation time.

---

## [HIGH] Findings

### H1 — gv-worker Binds to 0.0.0.0 by Default
`gv-server/src/worker.rs:522`

```rust
cmd.env("GV_BIND_ADDR", "0.0.0.0");
```

gv-server **always** overrides `GV_BIND_ADDR` to `0.0.0.0`, meaning gv-worker listens on all network interfaces. The worker's own default (main.rs:1321) is `127.0.0.1`, but gv-server overrides it unconditionally.

Combined with C1 (permissive CORS), any machine on the LAN or (if exposed via firewall/NAT) the internet can reach the worker's HTTP endpoints.

**Impact:** Network exposure of gv-worker beyond the intended LAN scope. Particularly dangerous on cloud VPS deployments.

**Fix:** Don't hardcode the override. Let `GV_BIND_ADDR` control this, and set it in the environment/deployment config:
```rust
// Only override if not already set
if std::env::var("GV_BIND_ADDR").is_err() {
    cmd.env("GV_BIND_ADDR", "0.0.0.0"); // or use configurable setting
}
```

---

### H2 — Missing Env Vars in .env.example Files

Several env vars are read at runtime but not documented in any `.env.example`:

| Variable | Where Used | Default |
|----------|-----------|---------|
| `GV_MIN_OUTPUT_HEIGHT` | `gv-worker/src/config.rs:28` | 480 |
| `DC_AUTH_TIMEOUT_SECS` | `gv-worker/src/config.rs:172` | 5 |
| `GV_AUDIO_CHANNELS` | `gv-worker/src/main.rs:286` | 2 |
| `GV_SAVE_DIR` | `gv-worker/src/saves.rs` (referenced) | none |
| `GV_SYSTEM_DIR` | gv-worker (BIOS path) | none |
| `GV_ROM_ROOTS` | `gv-server/src/main.rs:69` | empty |
| `SERVER_API_KEY` | `/dev` dashboard (`gv-web/.env.example` has it, but root `.env.example` doesn't) | none |

**Impact:** Production operators cannot discover or configure these settings without reading source code. Missing `GV_SAVE_DIR`/`GV_SYSTEM_DIR` means BIOS-dependent cores (PS1, Saturn) silently fail.

**Fix:** Add all runtime-configurable env vars to the root `.env.example` with documented defaults and descriptions.

---

### H3 — Env Var Inconsistency Across Components

The root `.env.example` and `gv-web/.env.example` have different scopes and partially duplicated content:

| Variable | Root `.env.example` | `gv-web/.env.example` | `gv-worker/.env.example` |
|----------|---------------------|------------------------|--------------------------|
| `GV_WORKER_BIN` | ✓ | — | — |
| `GV_WORKER_HOST` | ✓ | — | — |
| `STUN_SERVER` | ✓ | — | ✓ |
| `TARGET_BITRATE_KBPS` | ✓ | — | ✓ |
| `ALLOWED_ORIGIN` | ✓ | — | ✓ |
| `AUTH_GITHUB_ID` | ✓ | ✓ | — |
| `AUTH_GITHUB_SECRET` | ✓ | ✓ | — |
| `LAN_USER/LAN_PASS` | ✓ | — | — |
| `DATABASE_URL` | — | ✓ | — |
| `AUTH_SECRET` | — | ✓ | — |
| `SERVER_API_KEY` | — | ✓ | — |
| `GV_BIND_ADDR` | — | — | ✓ |
| `GV_HOST_TOKEN` | — | — | ✓ |
| `GV_CORE_PATH` | — | — | ✓ |
| `GV_CONTENT_PATH` | — | — | ✓ |

`DEPLOY.md:166` references `GV_WEB_URL` which **doesn't exist** in any `.env.example` or in the gv-server source code (the URL comes from `config.toml`).

**Impact:** Operational confusion — operators don't know which file to configure for which component. The gv-worker `.env.example` contains variables normally set by gv-server at spawn time, making it misleading.

**Fix:** Consolidate to a single shared `.env.example` at the root that documents ALL variables, annotated with which component reads each one. Remove the gv-worker `.env.example` or make it reference the root file.

---

### H4 — Viewer-to-Host Session Hijack via Leaked GV_HOST_TOKEN

`gv-server/src/worker.rs:525-527` passes the host token to gv-worker as an env var:
```rust
if let Some(token) = host_token {
    cmd.env("GV_HOST_TOKEN", token);
}
```

And `gv-worker/src/main.rs:1291` reads it:
```rust
let host_token = std::env::var("GV_HOST_TOKEN").ok();
```

The host token is set once at worker spawn and **never rotates**. If a viewer somehow learns the token (log leakage, process inspection via `/proc`, debugging), they can send an `{"cmd":"auth","host_token":"..."}` on their DataChannel and become Host, gaining full save/load/bitrate control.

Additionally, the host token is transmitted in the SDP offer JSON body:
```json
{"sdp": "...", "host_token": "..."}
```
This goes to gv-server as a `sdp_offer` command payload, which logs it. The `sdp_offer` handler at main.rs:298-391 does not strip the host_token before forwarding to the worker's `/sdp` endpoint.

**Impact:** Any attacker who can read gv-server logs or `/proc/<pid>/environ` can hijack the host role mid-session.

**Fix:** 
1. Don't log the full SDP offer payload (strip `host_token` before logging).
2. Consider rotating the host_token after authentication (one-time use) or use a challenge-response instead of a static token.
3. Protect `/proc/<pid>/environ` with `ProtectProc=invisible` in the systemd unit (already partially mitigated by `ProtectSystem=full`).

---

### H5 — No Rate Limiting on Any Endpoint

None of the API endpoints implement rate limiting:

- `/api/auth/pair/claim` — brute-force pairing codes (8 alphanumeric chars, ~2.8 trillion space, but no throttle)
- `/api/server/command` — create arbitrary numbers of commands
- `/api/server/notify?GET` — brute-force worker_token (32 hex chars)
- `/api/server/poll` — tight poll loops (250ms fast mode) could be exploited
- gv-worker `/sdp` — no limit on SDP negotiation attempts

**Impact:** DoS via command flood, pairing code brute-force (though limited by 5-min TTL and one-time use), worker_token guessing via timing side-channels.

**Fix:** Add rate limiting middleware to gv-web. At minimum: 5 attempts/sec for claim, 30 req/min for command, 10 req/sec for notify GET. Use `next-rate-limit` or similar.

---

## [MEDIUM] Findings

### M1 — PROTOCOL.md vs Code: Poll Method Mismatch

**PROTOCOL.md line 144:**
```
POST /api/server/poll
```

**API.md line 151:**
```
POST /api/server/poll
```

**Actual code (`gv-web/app/api/server/poll/route.ts:37`):**
```typescript
export async function GET(request: Request)
```

The poll endpoint is a GET, not POST. gv-server's client code (gv_web.rs:145) uses GET correctly:
```rust
let resp = self.client.get(&url)
```

So the documentation is wrong, not the code. But the docs say "Request body: `{"server_id": "..."}`" which doesn't apply to GET requests — the server_id is extracted from the bearer token, not the body.

**Fix:** Update PROTOCOL.md and API.md to say `GET /api/server/poll` and remove the request body description. Note that `server_id` is implicit in the bearer token.

---

### M2 — Hardcoded PID File Directory

`gv-server/src/worker.rs:334`:
```rust
const WORKER_PID_DIR: &str = "/tmp/gv-workers";
```

The PID directory is hardcoded. This means:
- Cannot run multiple gv-server instances on the same host (they'd conflict on PID files)
- On systems with `PrivateTmp=true` in systemd (not currently configured), PID files would be invisible
- `/tmp` may be tmpfs and cleared on reboot, which is actually desirable for crash recovery — but it also means that if the directory is on persistent storage, stale PID files survive reboots and the reaper kills valid processes on startup

**Fix:** Make `WORKER_PID_DIR` configurable via env var `GV_WORKER_PID_DIR`, defaulting to `/tmp/gv-workers`. Document in `.env.example`.

---

### M3 — Empty ROM Roots Cause Silent Failures

`gv-server/src/main.rs:151-155`:
```rust
let rom_roots: Vec<String> = cfg.rom.as_ref()
    .map(|r| r.roots.clone())
    .unwrap_or_default();
```

When `rom_roots` is empty (no `GV_ROM_ROOTS` env var set during pairing, no `[rom]` section in config.toml), all `start_game` commands fail with `"rom_path not found in any ROM root"`. The error is logged on the server side but the browser receives no feedback — the command appears to succeed (returns 201 with a worker_token), but the worker never gets a valid content path.

The gv-server then spawns a worker without `GV_CONTENT_PATH`, and the worker falls back to test pattern — the user sees a "Core unavailable" error screen instead of their game.

**Impact:** Poor UX — users think the game is loading but it silently fails. Hard to diagnose without server log access.

**Fix:** 
1. If ROM roots are empty and a `start_game` command arrives, reject it with a clear error.
2. Alternatively, log a prominent WARN at server startup: "No ROM roots configured — games will not load."

---

### M4 — SDP Relay Has No Retry; Single Point of Failure

`gv-server/src/main.rs:328-385`

When gv-server relays an SDP offer to the worker and gets back an answer, there's a single POST with no retry. If this fails (network blip, worker overloaded):
- The SDP answer never reaches gv-web
- The browser polls `/api/server/notify?GET` and never gets an `sdp_answer`
- The WebRTC connection stalls indefinitely

Compare with `notify()` and `notify_stop()` which retry 3x with exponential backoff.

**Fix:** Wrap the SDP relay in `retry::with_retry(3, ...)` similar to notify calls.

---

### M5 — Shutdown Order: gv-server Kills Workers Before Notifying gv-web

`gv-server/src/main.rs:269-297` (stop_game handler):
```rust
if let Some(worker) = workers.remove(game_id) {
    worker.kill().await;        // kills worker first
    if let Err(e) = client.notify_stop(&cmd.id, game_id).await {
        // notify happens after kill
    }
}
```

If `notify_stop` fails (gv-web unreachable), the worker is already dead but gv-web's session still shows `status: "ready"`. The browser keeps polling and never learns the game ended. This is partially mitigated by the worker's self-destruct timer, but the session record remains.

Also on shutdown (line 562-565):
```rust
for (game_id, worker) in workers {
    worker.kill().await;
}
```
No notification to gv-web at all on server shutdown.

**Impact:** Orphaned session records in the database. Browser shows stale "connecting..." state.

**Fix:** Notify gv-web BEFORE killing workers. On server shutdown, send stop notifications for all active workers (fire-and-forget with a short timeout).

---

## [LOW] Findings

### L1 — LAN Auth Synthetic User ID Collision

`gv-web/lib/auth.ts:70`:
```typescript
id: "a0000000-0000-0000-0000-000000000000",
```

All LAN-authenticated users share the same hardcoded UUID. This means:
- Multiple LAN users appear as the same identity
- Server membership and ownership are conflated
- If user A pairs a server via LAN auth, user B (also LAN) automatically has admin access to it

**Impact:** LAN auth is explicitly a "trusted network side door" (auth.ts:36-37), so this is by design. But the collision means LAN auth should only be used in single-user deployments.

**Fix:** Document this limitation clearly in `.env.example`. Consider using a hash of `LAN_USER` as the synthetic ID for multi-user LAN scenarios.

---

### L2 — Worker Crash During Port Read Leaks Child Process

`gv-server/src/worker.rs:561-638`

If gv-server crashes (SIGKILL, OOM) between spawning the child (line 561) and reading `WORKER_READY port=N` (line 583-619), the child process is orphaned. The PID file IS written (line 568-572), so the reaper will find it on restart. But if gv-server itself is never restarted, the orphan persists until the worker's own self-destruct timer fires (60s startup timeout).

**Impact:** Temporary orphan processes (max 60s). Low risk since workers self-terminate.

**Fix:** Already mitigated by worker self-destruct timer. No action needed beyond what's implemented.

---

### L3 — `GV_WEB_URL` Documented But Not Used

`docs/DEPLOY.md:166`:
```bash
GV_WEB_URL=http://localhost:3001
```

This env var never appears in any source code. gv-server gets its URL from `config.toml` (set during pairing), not from the environment. The variable is misleading.

**Fix:** Remove `GV_WEB_URL` from DEPLOY.md or replace with a note about `config.toml`.

---

## Key Integration Points — Detailed Analysis

### Auth Boundaries Map

```
Endpoint                          Auth Required          Actual Check
──────────────────────────────────────────────────────────────────────
/api/health                       None                   None ✓
/api/auth/pair/generate           OAuth session          auth() ✓
/api/auth/pair/claim              Code-based             None (by design) ✓
/api/auth/verify                  API key bearer         verifyBearerToken() ✓
/api/server/command               OAuth + admin role     auth() + membership check ✓
/api/server/poll                  API key bearer         verifyBearerToken() ✓
/api/server/notify POST           API key bearer         verifyBearerToken() ✓
/api/server/notify GET            OAuth session          **NONE** ✗ (C3)
/api/server/result                API key bearer         verifyBearerToken() ✓
/api/commands/[id]/result         OAuth session          auth() + membership ✓
/api/servers/members              API key bearer         verify*Token() ✓
/api/servers/[id]/rom-roots       API key bearer         verifyBearerToken() ✓
gv-worker /sdp                    None                   **Permissive CORS** ✗ (C1)
gv-worker /health                 None                   None (by design) ✓
gv-worker /shutdown               None                   None **✗** (see note)
```

**Note on `/shutdown`:** No auth on the shutdown endpoint. Any process on the machine can POST to `/shutdown` and kill the worker. In practice, only gv-server calls this, and it runs on the same host. But network exposure (H1) makes this reachable.

### Data Flow: User Input Across Trust Boundaries

```
Browser input (game_id, sdp, host_token)
  → POST /api/server/command
  → Stored in commands.payload (jsonb, unvalidated)
  → Delivered to gv-server via poll
  → rom_path extracted from enriched payload (DB lookup)
  → Resolved with Path::join() — **NO CONTAINMENT CHECK** (C2)
  → Passed to gv-worker as GV_CONTENT_PATH env var
  → Loaded by libretro core

Browser binary input (3-byte RetroArch format)
  → WebRTC DataChannel
  → gv-worker on_message handler
  → port byte extracted, state extracted
  → CoreCommand::SetInput sent to libretro thread
  ✓ Always allowed regardless of auth role (by design)
  ✓ 3-byte length check prevents buffer issues
  ✓ port byte is validated by core thread

Browser JSON commands (save_state, load_state, set_bitrate, etc.)
  → WebRTC DataChannel
  → gv-worker on_message handler
  → Role gate: Host only for privileged commands
  ✓ Viewer commands rejected with logged warning
  ✓ Unknown commands dropped silently
```

### Process Lifecycle

```
gv-server start
  ├── reap_stale_workers() — kill orphans from previous crash
  ├── poll loop (GET /api/server/poll every 250-2000ms)
  │   ├── start_game → spawn_worker()
  │   │   ├── resolve_worker_bin (config > env > auto-detect)
  │   │   ├── spawn gv-worker 0 (port 0, stderr piped)
  │   │   ├── write PID file /tmp/gv-workers/<game_id>.pid
  │   │   ├── read stderr until WORKER_READY port=N (5s timeout)
  │   │   ├── health check GET /health
  │   │   ├── notify gv-web (3 retries, exponential backoff)
  │   │   └── insert into workers HashMap
  │   ├── stop_game → workers.remove().kill()
  │   │   ├── POST /shutdown (graceful, 3s timeout)
  │   │   ├── wait 2s for exit
  │   │   ├── SIGKILL if still alive
  │   │   ├── remove PID file
  │   │   └── notify_stop gv-web (3 retries)
  │   ├── sdp_offer → relay to worker, relay answer to gv-web
  │   ├── browse_files → scan::resolve_within_roots() + browse_path()
  │   └── scan_paths → scan::resolve_within_roots() + discover_roms() + hash_files()
  ├── shutdown signal (SIGINT/SIGTERM)
  │   └── drain workers: for each worker { kill().await }
  └── exit

gv-worker lifecycle
  ├── startup timeout: 60s (self-destruct if no peer connects)
  ├── accept SDP offer → do_webrtc_handshake()
  │   ├── cancel old stream + abort old handle
  │   ├── cancel self-destruct timer
  │   ├── create peer connection + tracks
  │   ├── SDP exchange with ICE gathering (10s timeout)
  │   ├── await DataChannel (5s timeout)
  │   ├── spawn DC auth timeout (5s to send auth message)
  │   └── spawn streaming loop
  ├── streaming loop
  │   ├── per-frame: encode + write video sample
  │   ├── drain audio queue
  │   ├── on disconnect (Failed/Closed): cancel stream
  │   └── on exit: close peer connection, start self-destruct timer
  └── self-destruct: 30s idle timeout after disconnect
```

**Graceful shutdown completeness:** ✓ Good
- gv-server handles SIGINT/SIGTERM properly
- Workers are killed with graceful shutdown first (POST /shutdown), then SIGKILL
- PID files cleaned on all paths (kill, drop, reaper)
- Worker self-destruct prevents indefinite orphans
- **Gap:** No gv-web notification on server shutdown (M5)

### Config Surface Audit

| Setting | Configurable? | Default | Override |
|---------|--------------|---------|----------|
| Worker binary path | config.toml > env > auto-detect | `./target/release/gv-worker` | GV_WORKER_BIN |
| Worker hostname | env | LAN IP or localhost | GV_WORKER_HOST |
| Web timeout | env | 30s | GV_WEB_TIMEOUT_SECS |
| STUN server | env | `stun:stun.l.google.com:19302` | STUN_SERVER |
| VP8 bitrate | env | 500 kbps | TARGET_BITRATE_KBPS |
| CORS origins | env (dead code) | permissive | ALLOWED_ORIGIN |
| Video resolution | compile-time | 320×240 | — |
| Video FPS | compile-time | 60 | — |
| Audio sample rate | compile-time | 48 kHz | — |
| Audio channels | env | 2 | GV_AUDIO_CHANNELS |
| Min output height | env | 480 | GV_MIN_OUTPUT_HEIGHT |
| ICE gathering timeout | compile-time | 10s | — |
| DC receive timeout | compile-time | 5s | — |
| DC auth timeout | env | 5s | DC_AUTH_TIMEOUT_SECS |
| Worker idle timeout | compile-time | 30s | — |
| Worker startup timeout | compile-time | 60s | — |
| PID directory | **hardcoded** | `/tmp/gv-workers` | — |
| Core download URL | env | buildbot nightly | GV_BUILDBOT_URL |
| Cores directory | env | `./test-data/cores/` | GV_CORES_DIR |
| Core overrides | env (per-platform) | table in worker.rs | GV_CORE_OVERRIDE_* |
| ROM roots | env or config.toml | empty | GV_ROM_ROOTS |
| Bind address | env (overridden) | 127.0.0.1 | GV_BIND_ADDR |
| Postgres port (dev) | env | 5433 | GV_PG_PORT |

**Missing production overrides:**
- `GV_WORKER_PID_DIR` — can't change PID file location
- `VIDEO_WIDTH/HEIGHT/FPS` — compile-time only; can't adjust without recompilation
- `ICE_GATHERING_TIMEOUT_SECS` — can't tune for high-latency networks
- `WORKER_IDLE_TIMEOUT_SECS` — can't extend for slow reconnects

---

## Error Propagation Summary

| Failure | Server Impact | User-Visible? | Recovery |
|---------|--------------|---------------|----------|
| Worker spawn fail | Logged, server continues | No (browser polls forever) | Submit new command |
| Worker crash mid-stream | Stream loop exits, peer closed | Video freezes, eventually WebRTC disconnect | Self-destruct timer restarts; browser must reconnect |
| Notify fail (start) | Logged + fallback message with URL | No (manual intervention needed) | Operator reads log |
| Notify fail (stop) | Logged | No (session stays "ready") | Cleanup deletes session after 1h |
| Poll fail | Backoff 5s, retry | No (commands queued) | Next poll cycle |
| Core download fail | Worker uses test pattern | Yes (error screen) | Manual core placement or retry |
| SDP relay fail | Logged, no retry | Yes (WebRTC hangs) | Browser must re-submit sdp_offer |
| DB connection fail | gv-web 500s | Yes (API errors) | Connection pool retry |
| ROM roots empty | Worker starts without content | Yes (test pattern) | Configure ROM roots |

---

## TOP 5 FIXES (Priority Order)

### 1. [CRITICAL] Fix CORS on gv-worker
**Files:** `gv-worker/src/main.rs:1313`, `gv-worker/src/config.rs:128-152`

Replace `CorsLayer::permissive()` with `CorsLayer::new()` configured from `allowed_origins()`. Remove `#[allow(dead_code)]` from `allowed_origins()`. In production, require `ALLOWED_ORIGIN` env var and refuse to start if unset.

### 2. [CRITICAL] Add ROM Path Traversal Guard in start_game
**File:** `gv-server/src/main.rs:189-203`

Replace inline `Path::join()` + `exists()` with `scan::resolve_within_roots()`. This immediately blocks path traversal attacks (../../etc/passwd, symlink escapes).

### 3. [CRITICAL] Add Auth to GET /api/server/notify
**File:** `gv-web/app/api/server/notify/route.ts:92-133`

Add `auth()` call at the top of the GET handler to require an OAuth session. The worker_token alone is insufficient protection given URL leakage risks.

### 4. [HIGH] Move worker_token from URL to Header or Body
**Files:** `gv-web/app/api/server/notify/route.ts:98`, browser player code

Change from `?worker_token=X` to `X-Worker-Token: X` header or POST body. This eliminates URL-based token leakage (browser history, logs, referrer headers).

### 5. [HIGH] Don't Override GV_BIND_ADDR Unconditionally
**File:** `gv-server/src/worker.rs:522`

Only set `GV_BIND_ADDR=0.0.0.0` if no explicit bind address is configured. In production, default to `127.0.0.1` and let the reverse proxy handle external access. Combined with fix #1, this dramatically reduces network attack surface.

---

## Appendix: Files Audited

| File | Lines | Focus Area |
|------|-------|-----------|
| `.env.example` | 93 | Root env config |
| `gv-web/.env.example` | 12 | Web env config |
| `gv-worker/.env.example` | 29 | Worker env config |
| `docs/PROTOCOL.md` | 450 | Protocol spec |
| `docs/DEPLOY.md` | 259 | Deployment guide |
| `docs/configuration.md` | 148 | Config reference |
| `docs/gv-worker-api.md` | 164 | Worker API |
| `docs/API.md` | 338 | Web API |
| `docs/adr/002-worker-token-auth.md` | 36 | Token auth ADR |
| `docs/adr/017-command-permissions.md` | 364 | Permission ADR |
| `gv-server/src/main.rs` | 602 | Command handler |
| `gv-server/src/config.rs` | 97 | Config loading |
| `gv-server/src/worker.rs` | 873 | Process management |
| `gv-server/src/gv_web.rs` | 311 | Web client |
| `gv-server/src/scan.rs` | 384 | ROM scanning + path guards |
| `gv-server/src/retry.rs` | 98 | Retry helper |
| `gv-worker/src/main.rs` | 1355 | Server + WebRTC |
| `gv-worker/src/config.rs` | 195 | Worker config |
| `gv-web/lib/auth.ts` | 93 | Auth providers |
| `gv-web/lib/server-auth.ts` | 100 | Server auth |
| `gv-web/lib/constants.ts` | 28 | Shared constants |
| `gv-web/lib/db/schema.ts` | 159 | DB schema |
| `gv-web/lib/db/cleanup.ts` | 55 | TTL cleanup |
| `gv-web/app/api/server/command/route.ts` | 132 | Command endpoint |
| `gv-web/app/api/server/poll/route.ts` | 77 | Poll endpoint |
| `gv-web/app/api/server/notify/route.ts` | 133 | Notify endpoint |
| `gv-web/app/api/server/result/route.ts` | 50 | Result endpoint |
| `gv-web/app/api/auth/verify/route.ts` | 14 | Verify endpoint |
| `gv-web/app/api/auth/pair/claim/route.ts` | 101 | Pair claim |
| `gv-web/app/api/commands/[id]/result/route.ts` | 42 | Command result |
| `gv-web/app/api/servers/[server_id]/rom-roots/route.ts` | 30 | ROM roots |
| `gv-web/app/api/servers/members/route.ts` | 108 | Members |
| `scripts/dev-start.sh` | 310 | Dev launcher |
