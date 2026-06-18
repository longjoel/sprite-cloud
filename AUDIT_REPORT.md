# Games Vault — Web Readiness Report (Corrected)

**Date:** 2026-06-18
**Scope:** Critical assessment of current production readiness for public web deployment.
**Verdict:** The core single-player pipeline works. You can play a game. But there's no production safety net, no multi-user support, and no deployment path for end users.

---

## 1. What Actually Works ✓ (Verified)

| Component | Status | Evidence |
|---|---|---|
| gv-web (Next.js 15) | Healthy | Docker `Up 11 hours (healthy)` |
| gv-server polling loop | Healthy | Docker `Up 8 hours (healthy)`, spawns workers |
| Single-binary pattern | Implemented | `gv-server worker` subcommand |
| GStreamer VP8/Opus encoding | Working | worker-v2 pipeline, tuned for N100 |
| WebRTC P2P | Working | ICE IPv4 filter in place |
| Auth: GitHub OAuth + LAN | Working | NextAuth.js, pairing codes, verify flow |
| Session state machine | Implemented | spawning→ready→connected→playing→ended |
| Libretro core loading | Working | Real cores (NES, SNES, Genesis, etc.) |
| Keyboard input | Working | Joel played Adventure Island for 1+ minute — input responsive throughout |
| Audio pipeline | Working | rubato resampling + Opus 20ms frames |
| stop_game on disconnect | Implemented | GamePlayer.tsx sends stop_game on unmount (fire-and-forget with keepalive) |
| Reconnect with backoff | Implemented | `reconnectAttempts` counter, `MAX_RECONNECT_ATTEMPTS`, `RECONNECT_DELAY_MS`, no recursion |
| CORS on worker | Restricted | `CorsLayer::new()` with `config::allowed_origins()`, not permissive |
| SCTP ErrChunk | Benign | WARN log fires but does NOT prevent gameplay — cosmetic only |
| Design tokens | Implemented | Humidor design system (CSS vars + TS constants) |
| Deep health endpoint | Implemented | `/api/health` reports DB, schema, server status |

---

## 2. What's Missing — Production Safety Net

### 2.1 No Rate Limiting 🔴

No rate limiting on any endpoint. An attacker can:
- Brute-force pairing codes (`POST /api/auth/pair/claim` — no auth required)
- Spam `start_game` commands to exhaust server resources
- Hammer notify polling endpoints

No `429 Too Many Requests` anywhere in the codebase. `lib/rate-limit.ts` exists as a stub but isn't wired to any route.

### 2.2 No CSP Headers 🔴

`next.config.ts` contains no Content-Security-Policy. If any XSS vector is introduced, nothing stops script execution.

### 2.3 No Multi-Peer Support 🔴

Worker holds `peer_connection: Mutex<Option<Arc<RTCPeerConnection>>>` — single slot. A second SDP offer kills the first. This means:
- No guests can join a session
- No watchers can spectate
- No multiplayer
- No room sharing flow

The multi-peer plan (#325, umbrella with 13 child issues 326-338) is entirely unbuilt.

### 2.4 No TURN Server 🟡

Uses Google's public STUN (`stun.l.google.com:19302`). Production needs a TURN server for NAT traversal. No TURN configured. Symmetric NAT users will fail.

### 2.5 ROM Path Protection Incomplete 🟡

`start_game` handler uses manual `join + exists()` check. The stronger `resolve_within_roots()` (canonicalization + prefix containment) exists in `scan.rs` but isn't used in the start_game path. This is a defense-in-depth gap, not an exploitable vulnerability (the `exists()` check prevents traversal).

### 2.6 Shared LAN User Identity 🟡

All LAN users share `id: "a0000000-0000-0000-0000-000000000000"`. They see each other's servers and sessions. Fix is designed (deterministic UUID from username hash) but not implemented.

### 2.7 Worker Zombie Edge Cases 🟡

- PID recycling TOCTOU in the reaper (reads PID from file, sleeps 500ms, kills — PID may be recycled)
- Worker `Drop` calls `kill()` without `wait()` — potential zombies on Linux

The common case (tab close → stop_game → worker exits) works. These are edge cases.

### 2.8 ICE Teardown Race Status Unknown

The old `gv-worker` crate had a `#[ignore]` test for this. The crate was deleted. The gv-worker-v2 code may have fixed this during the GStreamer rewrite. Needs verification.

---

## 3. Missing Production Infrastructure

### Testing
| Test | Status |
|---|---|
| End-to-end smoke test (browser → video) | ❌ Not written |
| Worker chaos test (kill mid-stream) | ❌ Not written |
| Load test (5 concurrent games) | ❌ Not written |
| Multi-peer integration smoke test | ❌ Not written |

### Deploy/Distribution
| Capability | Status |
|---|---|
| curl \| sh install script | ❌ Not built |
| Self-contained static binary | ❌ Not built |
| Bazzite OOBE test | ❌ Not done |
| Server management UI | ❌ Not built |
| `.env.example` consolidation | ❌ 3 separate files |
| VPS deployment | ❌ Bare (only Traefik, GV purged 2026-06-18) |

### Observability
| Capability | Status |
|---|---|
| Server status in UI | ❌ Not built |
| Command timeout alerting | ❌ Not built |
| Worker health endpoint | ❌ Not built |
| Stats overlay (FPS, bitrate) | ❌ Not built |

---

## 4. Open GitHub Issues

39 open issues (38 enhancement, 1 low-severity bug). Heavily weighted toward:
- Multi-peer WebRTC (#325-338)
- Distribution (#311-316)
- Production hardening (#259-262)
- Frontend polish (#339-343, #349)

No open bugs for the rate limiting, CSP, or ROM path protection gaps — these are documented in the production hardening plan but not yet tracked as GitHub issues.

---

## 5. The Production Hardening Plan

`docs/plans/2026-06-16-production-hardening.md` defines 22 tasks across 5 phases:

| Phase | Tasks | Status |
|---|---|---|
| 1: Kill the Zombies (stability) | 3 tasks | ❌ Not started |
| 2: Lock the Doors + Room Sharing | 10 tasks | ❌ Not started |
| 3: Stop the Bleeding (error handling) | 5 tasks | ❌ Not started |
| 4: Production Hardening | 4 tasks | ❌ Not started |
| 5: Testing & Confidence | 4 tasks (plus 3 from Phase 2) | ❌ Not started |

Some Phase 2 tasks were preemptively addressed:
- CORS restriction (Task 2.1) — already implemented
- stop_game on disconnect (Task 3.2) — already implemented
- Reconnect fix (Task 3.3) — already implemented

---

## 6. What "Ready For Web" Requires (Minimum)

1. **Rate limiting** on pairing, command, and notify endpoints
2. **CSP headers** on all responses
3. **TURN server** configured (or documented as required for remote play)
4. **ROM path protection** using `resolve_within_roots()` in start_game
5. **LAN user UUID** deduplication
6. **One end-to-end smoke test** that proves the chain works
7. **curl | sh install script** for self-hosted users

Without #1, the service is trivially DoS-able. Without #6, there's no proof it works after deploy. The rest are defense-in-depth.

Multi-peer (#325-338) and room sharing are the big feature gap but don't block a single-player-only MVP launch.

---

## 7. What Changed From the Initial Report

Three claims from the initial draft were wrong and have been corrected:
- **SCTP ErrChunk** — claimed it breaks input. Joel proved it doesn't. Benign log noise.
- **CORS permissive** — claimed `CorsLayer::permissive()`. Actually uses `config::allowed_origins()`.
- **No stop_game/reconnect explosion** — claimed these weren't implemented. Both are implemented and working.
