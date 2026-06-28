# Reconnect State Machine

This documents every state and transition in the page-refresh → reconnect → fallback
flow.  Generated from the actual code in `play.js`, `index.js`, and `commands/mod.rs`.

---

## State Definitions

### Layer 1: Page Shell (`page.tsx`)

| Name | Meaning |
|---|---|
| `loading` | Resolving short code via `/api/room/resolve/:code` |
| `error` | Resolution failed (404, timeout, network) |
| `resolved` | Got `{game_id, host_token, server_id}` — renders `<GamePlayer>` |

Transition: `loading` → `resolved` or `error`.  One-way, triggered by fetch.

### Layer 2: Connection Orchestrator (`play.js`)

| Name | Meaning |
|---|---|
| `idle` | Before first `doConnect()` call |
| `connecting` | `doConnect()` is executing |
| `reconnecting` | `doReconnect()` timer is armed, waiting for next attempt |
| `connected` | SDP exchange done + ICE established |
| `failed` | All reconnect attempts exhausted |

Key flags (mutable during lifecycle):

| Flag | Initial | Changed by |
|---|---|---|
| `isReconnect` | `!!hostTokenParam` | Catch block sets `false` on failure |
| `wasReconnect` | snapshot of `isReconnect` | **Never changes** |
| `gameStarted` | `false` | Set `true` after start_game or reconnect branch |
| `connecting` | `false` | Guard flag: `true` while `doConnect()` runs |
| `reconnectAttempts` | `0` | Incremented each `doReconnect()` call |
| `startGameToken` | `null` | Set by `startGame()` return |
| `sdpAnswer` | `null` | Set by `startGame()` return |

### Layer 3: WebRTC Client (`index.js` — GvPlayer)

| Name | Meaning |
|---|---|
| `State.IDLE` | No active connection |
| `State.CONNECTING` | PC created, ICE gathering or checking |
| `State.CONNECTED` | ICE established, media flowing |
| `State.ERROR` | ICE failed, DC closed unexpectedly |
| `State.DISCONNECTED` | Clean disconnect requested |

Key instance fields:

| Field | Set by | Cleared by |
|---|---|---|
| `_pc` | `_createPeerConnection()` | `disconnect()`, `_cleanup()` |
| `_roomToken` | `_pollForAnswer()` (notify response) | `disconnect()` |
| `_hostToken` | `connectViaRelay()` parameter | `disconnect()` |
| `_peerToken` | room/join response or parameter | `disconnect()` |

### Layer 4: Server Session (`commands/mod.rs`)

| Name | Meaning |
|---|---|
| `alive` | Session exists in `sessions` HashMap |
| `cancelled` | `session.cancel` token fired, worker stopping |
| `gone` | Removed from `sessions` HashMap |

Transition: `alive` → `cancelled` (DC close, no guests) → `gone` (next `handle_start_game`)

---

## Action/State Matrix

### Normal Flow: First-Time Host Start

```
[page.tsx]  loading ──resolve──▶ resolved
[play.js]   idle ──doConnect──▶ connecting
              │
              ▼ isReconnect=false, gameStarted=false
         startGame() ──POST /api/command {start_game, sdp}──▶ poll notify
              │                                              │
              │◀──────── sdpAnswer + workerToken ────────────┘
              ▼
         gameStarted=true, startGameToken set, sdpAnswer set
              │
              ▼
         connectViaRelay(..., sdpAnswer)  ← pre-baked path
              │ sdpAnswer && this._pc → setRemoteDescription
              ▼
         conn:connecting → conn:connected
              │
              ▼
         connected; persistUrl() → /p/CODE
```

**States:** idle → connecting → connected  
**Invalid:** None — this always works.

---

### Page Refresh (The Problem)

```
[page.tsx]  loading ──resolve──▶ resolved  (host_token in props)
[play.js]   isReconnect=true, wasReconnect=true, gameStarted=false
              │
              ▼ doConnect()
              │
         ┌────┴────┐
         │ Option A │  (OLD — removed in c9f86cb)
         │ Reconnect│  Create PC → sdp_offer → poll → TIMEOUT (5s)
         │ Attempt  │  → sets _roomToken → disconnect → retry
         │          │  → _roomToken leaks! → 403 invalid room_token
         └────┬────┘
              │ FAILS (session already cancelled)
              ▼
         ┌────┴────┐
         │ Option B │  (NEW — current code)
         │ Skip     │  isReconnect=false → fall through
         │ Reconnect│  → startGame() → new session
         └────┬────┘
              │
              ▼
         startGame() → server kills old session, creates new one
              │
              ▼
         sdpAnswer arrives → connectViaRelay (pre-baked path)
              │
              ▼
         conn:connected (NEW worker, NEW PC, NEW TURN allocation)
              │
              ▼
         connected; persistUrl skipped (wasReconnect=true)
```

**States:** loading → connecting → connected  
**Time:** ~2-3 seconds (no 5s timeout, no 11s ICE gather)  
**Invalid transitions eliminated:**
- `_roomToken` never set (no reconnect poll)
- PC never created in reconnect branch (no `onconnectionstatechange` race)
- `connecting` guard prevents concurrent `doConnect()`

---

### ICE Failure During Connection

```
[play.js]   connecting ──conn:connecting──▶ (ICE checking)
                                                │
                              ┌─────────────────┘
                              │ ICE FAILS (11s timeout)
                              ▼
[index.js]  State.ERROR ← _setState(ERROR) ← onconnectionstatechange
              │
              ▼
[play.js]   onStateChange → doReconnect() if reconnectAttempts < MAX
              │
              ▼
         reconnectTimer → disconnect() → doConnect()
              │                    │
              │ clears tokens      │ connecting=true guard
              │ _pc=null           │
              ▼                    ▼
         _roomToken=null     isReconnect=false
         _hostToken=null     gameStarted=true? NO — was set false in catch
         _peerToken=null
              │
              ▼
         doConnect() runs fresh:
           isReconnect=false, gameStarted=false
           → startGame() → connectViaRelay(pre-baked)
           → conn:connected
```

**States:** connecting → reconnecting → connecting → connected  
**Guards:** `connecting` flag, cleared tokens, cleared `isReconnect`

---

### DC Close → Session Cancelled (Server-Side)

```
[mod.rs]   alive ──DC close detected──▶ check guests
              │
         ┌────┴────┐
         │ No guests│ → session.cancel.cancel()
         │          │ → worker exits
         │          │ → session STAYS in HashMap (not removed)
         └────┬────┘
              │
              ▼
         cancelled ──next handle_start_game──▶ gone
              │                            sessions.remove(game_id)
              │                            old.cancel.cancel() (no-op)
              ▼
         new session created with fresh PC from pool
```

**Key:** DC close handler only cancels the token — it does NOT remove the session
from the HashMap.  The session stays in the map until `handle_start_game` cleans
it up.  This means a reconnect attempt between DC close and the next start_game
would find the session in the map but with `host_connected=false`.

---

### Multiple Simultaneous doReconnect() Calls (OLD — Fixed)

**Invalid state (before fix):**

```
[play.js]   connecting ──conn:failed──▶ State.ERROR
              │                            │
              │                            ▼
              │                       onStateChange → doReconnect() ①
              │
              ▼ (catch block for connectViaRelay error)
         doReconnect() ②
              │
         ┌────┴────┐
         │ Timer ① │──fires──▶ disconnect() ──▶ doConnect() ③
         │ Timer ② │──fires──▶ disconnect() ──▶ doConnect() ④  ← CONCURRENT!
         └─────────┘
              │
              ▼
         ③ creates PC, posts sdp_offer
         ④ calls disconnect() → nukes ③'s PC → ③ crashes or sends stale data
```

**Fix:** `connecting` guard + clear stale `reconnectTimer` in `doReconnect()`.

---

### _roomToken Propagation (OLD — Fixed)

**Invalid state (before fix):**

```
[play.js]   Option A (reconnect attempt)
              │
              ▼
         connectViaRelay → sdp_offer → _pollForAnswer
              │                          │
              │                   ┌──────┘
              │                   │ notify GET returns room_token
              │                   │ → player._roomToken = "abc123"
              │                   ▼
              │              poll times out (5s)
              │                   │
              ▼                   ▼
         catch block          _roomToken = "abc123"  ← STALE!
         isReconnect=false
         doReconnect() → timer → disconnect() → doConnect()
              │                    │
              │                    ▼  _roomToken=null ✓ (after bedff8b)
              ▼
         startGame() → connectViaRelay(..., player._roomToken || joinToken)
              │
              │ _roomToken was null → roomToken=undefined → NO room_token in payload
              │ BUT before bedff8b: _roomToken="abc123" → room_token in payload → 403!
              ▼
         sdp_offer POST (no room_token) → poll for answer → ICE ← SUCCESS
```

**Fix:** `disconnect()` clears `_roomToken`.  Option A removed entirely — no poll,
no `_roomToken` set in the first place.

---

## Complete Valid Transitions

```
                    ┌─────────────────────────────┐
                    │         PAGE LOAD            │
                    │  loading → resolved → play   │
                    └──────────┬──────────────────┘
                               │
                    ┌──────────▼──────────────────┐
                    │       FIRST CONNECTION       │
                    │  isReconnect=false           │
                    │  startGame → pre-baked SDP   │
                    │  → conn:connected            │
                    │  → persistUrl()              │
                    └──────────┬──────────────────┘
                               │
                    ┌──────────▼──────────────────┐
                    │        PAGE REFRESH          │
                    │  isReconnect=true → skip     │
                    │  → startGame (fresh session) │
                    │  → pre-baked SDP             │
                    │  → conn:connected            │
                    │  → URL stays (wasReconnect)  │
                    └──────────┬──────────────────┘
                               │
                    ┌──────────▼──────────────────┐
                    │        ICE FAILURE           │
                    │  State.ERROR → doReconnect   │
                    │  guard prevents concurrent   │
                    │  disconnect clears tokens    │
                    │  → startGame → connected     │
                    └──────────────────────────────┘
```

---

## State Coverage Checklist

| Scenario | State | Covered? | Notes |
|---|---|---|---|
| Fresh page load, no session | loading → resolved → idle → connecting → connected | ✅ | Works end-to-end |
| Refresh with live session | loading → resolved → connecting → connected | ✅ | Skip reconnect, start fresh |
| Refresh with dead session | loading → resolved → connecting → connected | ✅ | Same as above |
| ICE failure mid-connection | connecting → ERROR → reconnecting → connecting → connected | ✅ | Guard + token clear |
| DC close (no guests) | alive → cancelled → gone | ✅ | Cleanup handled |
| Multiple doReconnect calls | connecting → concurrent guard | ✅ | `connecting` flag |
| Guest join | loading → resolved → joining → connected | ✅ | Separate flow, works |
| Server restart mid-session | connecting → ERROR → reconnecting → connected | ✅ | Same as ICE failure |
| TURN allocation failure | connecting → ERROR → reconnecting | ✅ | Handled by ICE failure path |
| startGame timeout (no server) | connecting → error state | ⚠️ | Page shows error, no retry yet |
| Network loss after connected | connected → DISCONNECTED → ERROR → reconnecting | ⚠️ | Disconnected grace period exists but untested |

---

## Remaining Gaps

1. **No progress UI during reconnect.**  The page shows nothing for 2-3 seconds
   while `startGame()` long-polls.  Need status overlay ("Reconnecting…",
   "Starting game…", etc.) wired to `callbacks.onProgress`.

2. **No error recovery from terminal failures.**  If the server is completely
   unreachable (DNS down, power loss), the page sits on "Resolving…" or error
   forever.  Should show a "Retry" button after exhausting reconnect attempts.

3. **Firefox autoplay policy.**  After a fallback `start_game`, the
   `<video>` element needs a user gesture to play.  Works on first load but
   may fail on reconnect.  Need a "Tap to play" overlay.

4. **Server-side: no session health endpoint.**  The browser has no way to
   check if a session is alive without attempting a full WebRTC handshake.
   A lightweight `GET /api/session/:id/status` would let the client skip the
   reconnect attempt when the session is dead.
