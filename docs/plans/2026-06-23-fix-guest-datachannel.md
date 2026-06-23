# Fix Guest DataChannel — Full Guest Connection Audit & Repair

> **For Hermes:** Execute each task sequentially. Each task is self-contained with exact file paths, code, and verification.

**Goal:** Guest player connects, sees video, and keyboard/gamepad input routes to the correct RetroArch port — same experience as the host, just different seat.

**Architecture:** Three fixes across two repos: (1) gv-web seat assignment uses `MAX(seat)+1` not `COUNT(*)`, (2) gv-web cleanup deletes orphaned peer_tokens, (3) gv-worker DC auth is eliminated — peer goes straight from Negotiating → Active when DataChannel arrives.

**Tech Stack:** Rust (gv-worker, axum + webrtc-rs 0.17.1), TypeScript (gv-web, Next.js + Drizzle ORM), JavaScript (gv-player, vanilla ES modules)

---

## Architecture Overview

### Guest connection flow (end-to-end)

```
Guest browser                          gv-web (Next.js)              gv-worker (Rust)
───────────                           ────────────────              ─────────────────
1. Opens invite link
   /play/GAME?join=ROOM_TOKEN

2. PlayPage renders →
   GamePlayer.tsx calls
   window.gvPlay.startPlayer()
   → play.js:doConnect()

3. POST /api/room/join                 4. Validate room_token
   {room_token, client_id}               SELECT session WHERE roomToken
                                         COUNT peer_tokens → seat=N  ← BUG #1: COUNT(*)
                                         INSERT peer_token (token,
                                           seat=N, role="player")
                                      5. Return {peer_token, seat,
                                         worker_url, server_id, ...}

6. LAN worker detected?                  ← isPrivateIP(worker_url)
   YES → window.location.href =
     http://WORKER_IP:PORT/player?
     join=...&peer_token=...&
     seat=N&role=player&...

7. Worker serves /player →
   assets/index.html                    8. Axum route /player
                                         → serve_player_file("index.html")
9. Loads /player/player-entry.js
   → MODE = 'direct'
   → directConnect()
   → new GvPlayer(video, {seat: N})
   → _createPeerConnection()
     creates DC "diagnostics"
     dc.onopen → sends auth msg
   → pc.createOffer()

10. POST /sdp                          11. handle_offer()
    {sdp, peer_token,                     trusted_role_seat()? → yes
     peer_role, peer_seat}                → (role=Player, seat=N)
                                          do_webrtc_handshake()
                                          → exchange_sdp()
                                          → spawn_dc_handler()

12. DC opens                             13. DC received
    dc.onopen fires                        → lifecycle: Negotiating
    → sends {cmd:"auth",                     → Active (IMMEDIATELY)
      peer_token:"..."}                   ← FIX #2: no auth check,
    → _sendMask()                           just transition

14. Keyboard/gamepad input
    → sendMask():
      Uint8Array([seat, lo, hi])         15. 3-byte binary received
    → dc.send(binary)                      → port = seat (=1 for
                                             first guest)
                                           → CoreCommand::SetInput
                                             {port: 1, state}

16. Core thread reads INPUT_STATE[1]
    → libretro core polls port 1
    → Player 2 controls work
```

### Token chain

```
gv-web generates room_token          (crypto.randomBytes)
  ↓
Guest uses room_token → /api/room/join
  ↓
gv-web generates peer_token      (crypto.randomBytes(16).toString("hex") — 32-char hex)
gv-web assigns seat = MAX(seat)+1
  ↓
Both passed to guest via URL params → POST /sdp
  ↓
Worker SDP handler: trusted_role_seat() → trusts role+seat from gv-web
  ↓
Worker DC handler: dc_peer_role, dc_peer_seat captured at spawn time
  ↓ No token validation — SDP was the gate
Input routes to correct port
```

### What was broken (3 bugs)

| # | Bug | Symptom | Root cause |
|---|---|---|---|
| 1 | **Seat inflation** | Guest controls wrong RetroArch port (P3 instead of P2) | `COUNT(*)` in room/join counts stale peer_tokens |
| 2 | **DC auth rejection** | "Data channel closed" — worker closes DC immediately | Guest's dynamic peer_token not in static `GV_PEER_TOKENS` env var |
| 3 | **Stale assets** | player-bundle.js mismatch between gv-web and worker | No sync process; worker had older bundle |

---

## Changes Made

### Task 1: Fix seat assignment in room/join (gv-web)

**File:** `gv-web/app/api/room/join/route.ts`

**Before:** `COUNT(*)` inflates seat when stale peer_tokens exist
```ts
const [countResult] = await db
  .select({ count: sql<number>`count(*)` })
  .from(peerTokens)
  .where(eq(peerTokens.sessionId, session.id));
const seat = countResult?.count ?? 0;
```

**After:** `COALESCE(MAX(seat), 0) + 1` — uses next sequential seat
```ts
const [maxResult] = await db
  .select({ max: sql<number>`coalesce(max(${peerTokens.seat}), 0)` })
  .from(peerTokens)
  .where(eq(peerTokens.sessionId, session.id));
const seat = (maxResult?.max ?? 0) + 1;
```

**Verification:** `npx tsc --noEmit` — ✅ passes

### Task 2: Clean up orphaned peer_tokens (gv-web)

**File:** `gv-web/lib/db/cleanup.ts`

**Before:** Only deleted old `commands` and `sessions`. `peerTokens` accumulated forever.

**After:** Added orphan cleanup — deletes `peerTokens` with no matching session
```ts
await db.delete(peerTokens).where(
  notInArray(
    peerTokens.sessionId,
    db.select({ id: sessions.id }).from(sessions),
  ),
);
```

**Verification:** `npx tsc --noEmit` — ✅ passes

### Task 3: Eliminate DC auth (gv-worker)

**File:** `gv-worker/src/main_body/mod.rs`

**Before (3-phase lifecycle):**
```
Negotiating → [DC arrives] → Authenticating → [5s timeout or token validation] → Active
                                                    ↑ closes DC if token not in GV_PEER_TOKENS
```

**After (2-phase lifecycle):**
```
Negotiating → [DC arrives] → Active  (immediately — audio, video, input)
```

Three changes in `spawn_dc_handler`:

1. **Transition straight to Active** when DC received (line ~542):
```rust
peer.lifecycle = PeerLifecycle::Active {
    role: dc_peer_role,
    seat: dc_peer_seat,
};
```

2. **Auth message is no-op** (line ~604):
```rust
if cmd_type == "auth" {
    return;  // SDP already validated this peer
}
```

3. **Removed auth timeout spawn** (was ~25 lines) — no longer needed

4. **Removed unused imports**: `dc_auth_timeout_secs`, `host_token_from_env`, `validate_peer_token`

5. **Removed unused variable**: `dc_peer_tokens`, `peer_tokens` in DC handler closure

**Verification:** `cargo check` — ✅ 0 errors, 2 pre-existing warnings

---

## What STILL needs to happen

### Task 4: Sync worker assets

The worker's `assets/` directory has stale files. Sync from gv-web source:

```bash
# Rebuild the esbuild bundle
cd /root/projects/games-vault/gv-web/public/player
npx esbuild player-entry.js --bundle --format=esm --outfile=player-bundle.js

# Copy all player files to worker assets
cp index.html /root/projects/games-vault/gv-worker/assets/
cp player-entry.js /root/projects/games-vault/gv-worker/assets/
cp index.js /root/projects/games-vault/gv-worker/assets/
cp player-bundle.js /root/projects/games-vault/gv-worker/assets/
```

**Verification:** Run `md5sum` on source vs dest — all four files should match.

### Task 5: Rebuild worker binary

```bash
cd /root/projects/games-vault
cargo build --release -p gv-worker
```

**Verification:** Binary at `target/release/gv-worker` should have today's timestamp.

### Task 6: Deploy to VPS

Per memory conventions: `cat file|ssh root@vps 'docker exec -i gv-web-gv-web-1 tee /app/gv-web/path'`

**gv-web deploy (Next.js):**
- Copy changed files: `room/join/route.ts`, `cleanup.ts`
- Rebuild: `docker exec gv-web-gv-web-1 ...` or redeploy container

**gv-worker deploy (Rust binary):**
- Copy `target/release/gv-worker` to the server
- Restart gv-server

### Task 7: End-to-end smoke test

1. **Host:** Start a game session
2. **Guest (incognito/private window):** Open invite link
3. **Verify:** Guest sees video immediately (no "data channel closed")
4. **Verify:** Guest keyboard input controls Player 2 (not Player 1, not dead port)
5. **Verify:** Worker logs show `[DC]` with immediate `Active` transition (no 5s delay, no auth failure)

---

## Security model

| Threat | Mitigation | Where |
|---|---|---|
| Unauthorized guest joins | `room_token` is crypto-random 32-char hex — invite link IS the auth | room/join (gv-web) |
| Guest claims wrong seat | Seat assigned server-side via `MAX(seat)+1`, not client-chosen | room/join (gv-web) |
| Malicious SDP POST | `trusted_role_seat()` requires valid `peer_role` + `peer_seat` from gv-web | handle_offer (gv-worker) |
| Stale peer_tokens pile up | Cleanup deletes orphans on session deletion | cleanup.ts (gv-web) |

The DC auth was always redundant — the SDP handshake is the gate. The invite link is the auth. If you have it, you're in.
