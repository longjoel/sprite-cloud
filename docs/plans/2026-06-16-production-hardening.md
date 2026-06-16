# Production Hardening — Go-Live Readiness Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Make Games Vault rock-solid and stable enough for a public launch within one month. Fix all CRITICAL and HIGH audit findings, add production infrastructure, and build end-to-end confidence.

**Architecture:** Five phases, implemented sequentially. Each phase must complete (tests pass, smoke test green) before starting the next. Phases 1-2 are blocking for public launch. Phases 3-5 are quality-of-life but still required for "rock solid."

**Tech Stack:** Rust (edition 2024), Next.js 15, TypeScript, vanilla JS GvPlayer, PostgreSQL, webrtc-rs 0.17

---

## Security model (baked into each task)

| Threat | Mitigation | Phase |
|---|---|---|
| Orphaned workers → resource exhaustion | Kill child on spawn timeout, stop_game on disconnect | 1 |
| PID recycling → wrong process killed | Verify /proc/pid/comm before SIGKILL | 1 |
| Cross-origin WebRTC hijack | Restrict CORS to gv-web origin only | 2 |
| ROM path traversal | Use resolve_within_roots() in start_game handler | 2 |
| Token leakage via URLs | Worker tokens in POST body, not query params | 2 |
| Shared LAN user identity | Per-user UUID for LAN credentials | 2 |
| CSRF on game commands | CSRF token validation on POST /api/server/command | 2 |
| DataChannel silent failure | DC close/error → State.ERROR → reconnect | 3 |
| Reconnect spawns zombies | Stop old worker before starting new one | 3 |
| XSS via error messages | Sanitize server errors before displaying | 4 |

---

## Phase 1 — Kill the Zombies (stability)

### Task 1.1: Fix orphaned worker on spawn timeout
**Files:** `gv-server/src/worker.rs:622-623`
**Problem:** When spawn_worker() times out reading WORKER_READY, the child process is dropped without being killed. gv-worker orphans persist until manual intervention.
**Fix:** Before `anyhow::bail!`, call `child.kill()` and `child.wait()`.
**Test:** `cargo test -p gv-server --lib` — all pass. Manual: force a worker spawn timeout by passing invalid binary path, verify no orphaned process remains.

### Task 1.2: Fix PID recycling TOCTOU in reaper
**Files:** `gv-server/src/worker.rs:378-406`
**Problem:** reap_stale_workers() reads PID from file, sleeps 500ms, sends SIGKILL. Between read and kill, PID may have been recycled to an unrelated process.
**Fix:** Before SIGTERM, read `/proc/<pid>/comm` and verify it matches "gv-worker". Add `// SAFETY:` comments to all `libc::kill` calls. Only SIGKILL if comm matches.
**Test:** `cargo test -p gv-server reap` — all pass.

### Task 1.3: Fix Drop sends SIGKILL without wait() → zombie risk
**Files:** `gv-server/src/worker.rs:461-471`
**Problem:** SpawnedWorker::drop() calls libc::kill(SIGKILL) but never waits for the child. On Linux, this creates a zombie process (the Child's Drop doesn't reap it either).
**Fix:** After SIGKILL, call `child.wait()` (blocking, acceptable in destructors).
**Test:** `cargo test -p gv-server --lib` — all pass. The `drop_without_kill_leaves_pid_file` test should be reviewed — it currently expects the PID file to survive drop, which conflicts with the Drop impl's behavior.

---

## Phase 2 — Lock the Doors (security)

### Task 2.1: Restrict CORS on gv-worker
**Files:** `gv-worker/src/main.rs`
**Problem:** `CorsLayer::permissive()` allows any origin to make SDP offers and hijack WebRTC sessions.
**Fix:** Only allow the gv-web origin (read from ALLOWED_ORIGIN env var). Default to localhost:3001 in dev. Log a warning on startup if permissive CORS is active.
**Test:** `curl -H "Origin: https://evil.com" -X OPTIONS http://localhost:<port>` → 403.

### Task 2.2: Use resolve_within_roots() in start_game handler
**Files:** `gv-server/src/main.rs:189-203`
**Problem:** The start_game command handler joins the relative ROM path with each ROM root and checks `full.exists()`. This path traversal guard exists but the stronger `resolve_within_roots()` (which canonicalizes and verifies containment) is only used in the scanner, not here.
**Fix:** Replace the manual join+exists loop with `resolve_within_roots(Path::new(root).join(rel), &rom_roots)`. This gives canonicalization + containment check.
**Test:** `cargo test -p gv-server scan` — all pass. Manual: attempt path traversal via crafted rom_path in command.

### Task 2.3: Add CSRF protection to POST /api/server/command
**Files:** `gv-web/app/api/server/command/route.ts`
**Problem:** The command endpoint authenticates via NextAuth session cookie but has no CSRF token check. A malicious site could trigger game commands if the user is authenticated.
**Fix:** Require a `csrf_token` in the request body or `X-CSRF-Token` header. Use NextAuth's built-in CSRF token from the session cookie. Validate server-side.
**Test:** POST without token → 403. POST with valid token → 200.

### Task 2.4: Fix shared LAN user ID
**Files:** `gv-web/lib/auth.ts:70`
**Problem:** All LAN users share `id: "a0000000-0000-0000-0000-000000000000"`. They see each other's servers and sessions.
**Fix:** Generate a UUID per LAN user derived from their username (deterministic: `crypto.createHash('sha256').update(username).digest('hex').substring(0, 36)` as UUID format). Store in DB if needed for FK integrity.
**Test:** Two LAN users with different usernames get different IDs. Two logins with same username get same ID. Server membership queries return only own servers.

### Task 2.5: Worker tokens in POST body, not query params
**Files:** `gv-web/app/api/server/notify/route.ts`, `gv-web/public/player/index.js:468`
**Problem:** `GET /api/server/notify?server_id=X&token=Y` leaks tokens to browser history, server logs, and referrer headers.
**Fix:** Change to POST with JSON body: `{ server_id, token }`. Update the player poll loop accordingly.
**Test:** GET without token → 400. POST with body → 200.

### Task 2.6: Add auth to GET /api/server/notify
**Files:** `gv-web/app/api/server/notify/route.ts`
**Problem:** The notify endpoint only checks a query-param token. No session auth.
**Fix:** Require either valid NextAuth session OR valid worker_token in body. Log auth failures at WARN level.
**Test:** Unauthenticated GET → 401. GET with valid session → 200. POST with valid token → 200.

---

## Phase 3 — Stop the Bleeding (error handling)

### Task 3.1: Add DataChannel close/error handlers
**Files:** `gv-web/public/player/index.js:359-381`
**Problem:** DataChannel has no onclose or onerror handlers. If the DC fails while ICE is connected, the state stays CONNECTED and the user sees a frozen game with no error.
**Fix:** Add `this._dc.onclose = () => { console.warn("[DC] closed"); this._setState(State.ERROR, "DataChannel closed"); };` and `this._dc.onerror = () => { ... }`. Same for sendMask, ping, and auth send failures — they must transition to ERROR.
**Test:** Manual: simulate DC failure, verify state transitions to ERROR and reconnect triggers.

### Task 3.2: Send stop_game on disconnect and page unload
**Files:** `gv-web/components/GamePlayer.tsx:188-196`, `gv-web/public/player/play.js`
**Problem:** No stop_game is ever sent. Workers run indefinitely after tab close or disconnect.
**Fix:** 
- In GamePlayer unmount: fetch POST `/api/server/command` with `{ type: "stop_game", game_id }` using `keepalive: true`
- Add `beforeunload` handler with `navigator.sendBeacon()` fallback
- On reconnect: send stop_game for old session before starting new one
**Test:** Start game, close tab. Verify no worker process remains after 5s.

### Task 3.3: Fix reconnect recursion (single reconnect path)
**Files:** `gv-web/public/player/play.js:166-177`
**Problem:** doReconnect() recursively calls startPlayer() which creates a new GvPlayer + new reconnect closure. Each cycle spawns another worker. After 3 cycles: exponential explosion.
**Fix:** Single reconnect state machine outside the closure. Track reconnect attempt count at module level. Before reconnecting: send stop_game for old session, wait 1s, start new session. Use exponential backoff: 1s, 2s, 4s, 8s, 16s with jitter.
**Test:** Simulate 3 failed reconnects. Verify only 1 worker running (not 3+). Verify backoff timing.

### Task 3.4: Fix orphaned worker on connectViaRelay failure
**Files:** `gv-web/public/player/play.js:141-163`
**Problem:** startGame() succeeds (worker spawned) but connectViaRelay() fails. doReconnect() is called which calls startPlayer() → startGame() again, spawning a second worker. The first is orphaned.
**Fix:** If connectViaRelay fails: send stop_game for the existing session before attempting reconnect.
**Test:** Simulate relay failure. Verify only 1 worker running after reconnect.

### Task 3.5: Add fetch timeouts to all poll loops
**Files:** `gv-web/public/player/index.js:468-483`, and 3 other poll sites
**Problem:** fetch() inside poll loops has no AbortController/timeout. Network hang blocks the loop timeout check.
**Fix:** Wrap every fetch in a `Promise.race` with a 5-second timeout via AbortController. On timeout: treat as failure, trigger next poll cycle.
**Test:** Manual: simulate TCP hang, verify poll continues after timeout.

---

## Phase 4 — Production Hardening

### Task 4.1: Consolidate .env.example files (single source of truth)
**Files:** `.env.example`, `gv-worker/.env.example`, `gv-web/.env.example`
**Problem:** Three separate .env.example files, 7+ undocumented env vars (GV_ROM_ROOTS, GV_MIN_OUTPUT_HEIGHT, DC_AUTH_TIMEOUT_SECS, GV_AUDIO_CHANNELS, GV_SAVE_DIR, GV_SYSTEM_DIR).
**Fix:** Merge into single root `.env.example` with clear sections per component. Delete gv-worker/.env.example and gv-web/.env.example. Add ALL missing env vars.
**Test:** `grep 'GV_\|ALLOWED_\|AUTH_\|STUN_\|TARGET_\|LAN_' .env.example | wc -l` matches `grep -r 'std::env::var\|process.env' --include='*.rs' --include='*.ts' --include='*.tsx' | grep -v test | wc -l`.

### Task 4.2: Add Content-Security-Policy headers
**Files:** `next.config.ts`
**Problem:** No CSP headers. If an XSS vector is introduced, nothing stops script execution.
**Fix:** Add CSP headers allowing: 'self' scripts, 'unsafe-inline' styles (React), WebRTC connections, the player module script. Report violations to `/api/csp-report` (log-only for now).
**Test:** `curl -I http://localhost:3000 | grep Content-Security-Policy` shows header.

### Task 4.3: Add rate limiting
**Files:** `gv-web/middleware.ts` (or new `lib/rate-limit.ts`)
**Problem:** No rate limiting on any endpoint. Brute-force pairing codes, start_game spam, notify polling abuse.
**Fix:** In-memory rate limiter (or Redis for production): 5 POST /api/server/command per second per IP, 2 pairing attempts per IP per minute, 2 notify polls per second. Return 429 when exceeded.
**Test:** Rapid-fire start_game commands → 429 after 5th request within 1s.

### Task 4.4: Fix vpx_img_wrap memory leak
**Files:** `gv-worker/src/vp8_encoder.rs:192-216`
**Problem:** vpx_img_wrap with null_mut() data ptr causes libvpx to internally allocate I420 planes. These are overwritten with our own plane pointers at lines 214-216. The internal allocation is never freed — ~115KB per frame, ~6.9 MB/s at 60fps.
**Fix:** Pass the actual plane pointers to vpx_img_wrap instead of null_mut(). This avoids internal allocation entirely. Pre-allocate the vpx_image_t once and reuse across frames.
**Test:** `cargo test -p gv-worker` — all pass. Memory profiler shows flat memory usage over 1000 frames.

### Task 4.5: Encoder mutex offloaded to blocking thread pool
**Files:** `gv-worker/src/main.rs:925-930`
**Problem:** std::sync::Mutex<Vp8Encoder> is held during synchronous libvpx FFI encode, blocking the tokio async worker thread. Other async tasks stall.
**Fix:** Wrap encode call in `tokio::task::spawn_blocking`. Release the mutex before spawning (just clone the pixels). Or switch to `tokio::sync::Mutex`.
**Test:** `cargo test -p gv-worker` — all pass. No change in encode throughput.

### Task 4.6: Add health check endpoint to gv-worker
**Files:** `gv-worker/src/main.rs`
**Problem:** gv-worker has no `/health` endpoint. gv-server's health check hits `/` which may not be reliable.
**Fix:** Add `GET /health` returning `{ status: "ok", core: "<name>", frames: N }`. Add `GET /healthz` (lighter: just 200 OK for Docker HEALTHCHECK).
**Test:** `curl http://localhost:<port>/health` → 200 with JSON body.

---

## Phase 5 — Testing & Confidence

### Task 5.1: End-to-end smoke test (browser → video)
**Files:** `scripts/smoke-test-e2e.sh` (new)
**Problem:** No test exercises the full path: browser POST command → gv-server polls → spawns worker → SDP relay → WebRTC connect → video frames arrive.
**Fix:** Create a headless browser test (Playwright or Puppeteer) that:
1. Signs in via LAN auth
2. Starts a game (2048 core, no ROM needed)
3. Waits for WebRTC connection
4. Verifies at least 1 video frame arrives
5. Sends input, verifies state change
6. Disconnects, verifies worker is killed
**Test:** `bash scripts/smoke-test-e2e.sh` → exit 0 only if all steps pass.

### Task 5.2: Worker chaos test (kill worker mid-stream)
**Files:** `scripts/chaos-test.sh` (new)
**Problem:** What happens when a worker crashes mid-game? Does the server recover? Does the browser handle it?
**Fix:** Chaos test script:
1. Start a game (2048)
2. Verify streaming
3. `kill -9 <worker-pid>`
4. Verify gv-server detects death (health check fails)
5. Verify gv-server cleans up PID file
6. Verify browser reconnection works (or gets a clear error)
**Test:** `bash scripts/chaos-test.sh` → exit 0.

### Task 5.3: Load test (5 concurrent games)
**Files:** `scripts/load-test.sh` (new)
**Problem:** Can the server handle multiple concurrent games without resource exhaustion?
**Fix:** Spawn 5 parallel 2048 game sessions. Verify all 5 stream video. Verify no crashes, no OOM, CPU stays below 80%. Verify cleanup after all 5 stop.
**Test:** `bash scripts/load-test.sh` → exit 0.

### Task 5.4: Consolidate duplicate code
**Files:** `gv-server/src/scan.rs`, `gv-server/src/worker.rs`, `gv-server/src/dat.rs`
**Problem:** EXTENSION_MAP, CORE_MAP, and DAT_SYSTEM_NAMES are three overlapping tables. Adding a platform requires 3 edits. The existing test verifies consistency but doesn't eliminate the duplication.
**Fix:** Extract a single `PlatformManifest` const (or a code-generated table) that maps extension → platform name → core filename. This becomes the single source of truth for all three lookups.
**Test:** `cargo test -p gv-server --lib` — all pass. `every_scan_platform_has_core_mapping` still passes.

### Task 5.5: Extract shared polling utility
**Files:** New: `gv-web/lib/poll.ts`
**Files to update:** `gv-web/public/player/play.js:97-110`, `gv-web/public/player/index.js:468-483`, `gv-web/app/dev/page.tsx:175-198`, `gv-web/app/settings/[server_id]/client.tsx:340-361`
**Problem:** Four copies of the same fetch+poll loop pattern. Each has different timeout/retry behavior.
**Fix:** Create `pollUntil(fn, { interval, timeout, signal })` helper. Use it in all four locations. Add TypeScript types.
**Test:** All existing tests pass. Manual smoke test of player + dev page + settings.

---

## Verification checklist (before public launch)

- [ ] `bash scripts/smoke-test-core-mapping.sh` — ✅ all pass
- [ ] `bash scripts/smoke-test-e2e.sh` — ✅
- [ ] `bash scripts/chaos-test.sh` — ✅ worker death handled
- [ ] `bash scripts/load-test.sh` — ✅ 5 concurrent games
- [ ] `cargo test --workspace` — ✅ all pass (no regressions)
- [ ] `cargo clippy --workspace -- -D warnings` — ✅ zero warnings
- [ ] CORS: gv-worker rejects cross-origin SDP offers
- [ ] CSP headers present on all responses
- [ ] Rate limiting active on command, pairing, and notify endpoints
- [ ] Single .env.example covers all env vars
- [ ] `pkill -u games-vault; bash scripts/dev-start.sh start` — stack comes up clean
- [ ] Tab close → worker killed within 5s
- [ ] Reconnect → old worker killed, new one spawned (not duplicated)
- [ ] No tokens in URLs or server logs
