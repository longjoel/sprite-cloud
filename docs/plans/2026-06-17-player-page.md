# Production Game Player Page — Implementation Plan (#156)

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Production-ready game player with both modal quick-play and dedicated /play page, expired session recovery, and navigation polish.

**Architecture:** Keep the existing modal (quick play from library) AND the dedicated /play/:game_id page (deep links). Both render GamePlayer.tsx. Add server-side validation and expired-session recovery on the page route.

**Tech Stack:** Next.js (App Router), React, TypeScript, existing GvPlayer/play.js WebRTC stack

**Current state:** The player UI (GamePlayer.tsx, 595 lines), connection glue (play.js, 283 lines), and WebRTC class (index.js, 925 lines) are fully built. Library opens GamePlayer in a modal via activeGame state. The /play/:game_id page handles ?join= (guest links) and ?server_id= params.

**What stays:**
- Modal quick-play in LibraryClient (unchanged)
- GamePlayer.tsx component (unchanged)
- play.js / index.js player classes (unchanged)
- Signaling relay endpoints (unchanged)

---

## Security model

| Threat | Mitigation | Where |
|---|---|---|
| Replay expired room tokens | Expired sessions show recovery UI, don't leak game/server info | Task 4 |
| Invalid server_id in URL | Server-side validation via /api/playable-hosts | Task 2 |
| Guest join without auth | Existing room/join flow verifies room_token server-side | Existing |

---

## Tasks

### Task 1: Add Back to Library button on /play page

**Objective:** When arriving at the dedicated page (not guest join), show a back button.

**Files:**
- Modify: `gv-web/app/play/[game_id]/page.tsx`

**What to do:**

1. Import `useRouter`:
```tsx
import { useRouter } from "next/navigation";
```

2. Add router and pass onClose to GamePlayer:
```tsx
const router = useRouter();
```

In the render block:
```tsx
<GamePlayer
  gameId={gameId}
  serverId={resolvedServerId}
  onClose={() => router.push("/")}
/>
```

GamePlayer already renders a "← Back" button when `onClose` is provided. Guest joins that resolved a server_id will also see this button (good — always have a way out).

**Acceptance:** /play page shows "← Back" button. Clicking navigates to library.

---

### Task 2: Server-side validation on /play page

**Objective:** When `server_id` is provided, validate the server exists, is online, and has the game before rendering the player.

**Files:**
- Modify: `gv-web/app/play/[game_id]/page.tsx`

**What to do:**

Add validation effect after the existing join-flow block, before rendering GamePlayer:

```tsx
const [validating, setValidating] = useState(!!serverId && !joinToken);
const [serverError, setServerError] = useState<string | null>(null);

useEffect(() => {
  if (!resolvedServerId || joinToken) return; // skip for guest joins
  
  (async () => {
    try {
      const resp = await fetch(`/api/playable-hosts?game_id=${encodeURIComponent(gameId)}`);
      if (!resp.ok) { setServerError("Failed to check server"); return; }
      const data = await resp.json();
      const host = (data.hosts || []).find((h: any) => h.server_id === resolvedServerId);
      if (!host) { setServerError("Server not found"); return; }
      if (!host.has_game) { setServerError("Game not available on this server"); return; }
      if (host.status === "offline") { setServerError("Server is offline"); return; }
    } catch {
      setServerError("Network error");
    } finally {
      setValidating(false);
    }
  })();
}, [resolvedServerId, gameId, joinToken]);
```

Add loading/error states before the GamePlayer render:

```tsx
if (validating) {
  return (
    <main style={{ ...styles.shell, background: "var(--color-mahogany)" }}>
      <div style={styles.center}>
        <p style={styles.text}>Checking server…</p>
      </div>
    </main>
  );
}

if (serverError) {
  return (
    <main style={{ ...styles.shell, background: "var(--color-mahogany)" }}>
      <div style={styles.center}>
        <p style={{ ...styles.text, color: "var(--color-error)" }}>{serverError}</p>
        <a href="/" style={styles.hint}>← Back to Library</a>
      </div>
    </main>
  );
}
```

**Acceptance:** `/play/:game_id?server_id=bogus` → "Server not found". Valid server+game → shows player. Guest joins skip validation.

---

### Task 3: Expired session recovery — start new game

**Objective:** When a guest join link is expired (worker dead, room_token invalid), offer to start a new session for the same game instead of showing a dead-end error.

**Files:**
- Modify: `gv-web/app/play/[game_id]/page.tsx`

**What to do:**

1. When join fails (joinError is set), fetch playable hosts for the game_id from the URL:

```tsx
const [recoveryHosts, setRecoveryHosts] = useState<any[] | null>(null);
const [recoveryLoading, setRecoveryLoading] = useState(false);

useEffect(() => {
  if (!joinError || !gameId) return;
  
  (async () => {
    setRecoveryLoading(true);
    try {
      const resp = await fetch(`/api/playable-hosts?game_id=${encodeURIComponent(gameId)}`);
      if (resp.ok) {
        const data = await resp.json();
        const online = (data.hosts || []).filter((h: any) => h.has_game && h.status !== "offline");
        setRecoveryHosts(online);
      }
    } catch { /* silently ignore */ }
    finally { setRecoveryLoading(false); }
  })();
}, [joinError, gameId]);
```

2. Replace the static join error UI with a recovery UI:

```tsx
if (joinError) {
  return (
    <main style={{ ...styles.shell, background: "var(--color-mahogany)" }}>
      <div style={styles.center}>
        <p style={{ ...styles.text, color: "var(--color-muted)" }}>
          Session expired or not found
        </p>
        {recoveryLoading && <p style={styles.hint}>Looking for available servers…</p>}
        {recoveryHosts !== null && recoveryHosts.length === 0 && (
          <p style={styles.hint}>No servers available for this game</p>
        )}
        {recoveryHosts !== null && recoveryHosts.length === 1 && (
          <a
            href={`/play/${gameId}?server_id=${recoveryHosts[0].server_id}`}
            style={{ ...styles.text, color: "var(--color-neon-cyan)", textDecoration: "underline", cursor: "pointer" }}
          >
            Start new session
          </a>
        )}
        {recoveryHosts !== null && recoveryHosts.length > 1 && (
          <>
            <p style={styles.hint}>Choose a server:</p>
            {recoveryHosts.map((h: any) => (
              <a
                key={h.server_id}
                href={`/play/${gameId}?server_id=${h.server_id}`}
                style={{ ...styles.hint, color: "var(--color-neon-cyan)", display: "block", marginTop: 8 }}
              >
                {h.name || h.server_id}
              </a>
            ))}
          </>
        )}
        <a href="/" style={{ ...styles.hint, marginTop: 16, display: "block" }}>
          ← Back to Library
        </a>
      </div>
    </main>
  );
}
```

**Acceptance:** Clicking an expired share link shows "Session expired — Start new session" with inline server picker. Clicking starts a fresh game. No servers available → "No servers available."

---

### Task 4: Remove gv-worker embedded test page routes

**Objective:** The gv-worker embedded test page is dead code. Remove the routes and handler functions but keep the minimal /healthz handler.

**Files:**
- Modify: `gv-worker/src/main_body.rs`

**What to do:**

1. Remove `handle_player_index` function
2. Remove `handle_player_js` function
3. Remove routes for these handlers
4. Keep `handle_index` (serves minimal health page at /)

**Acceptance:** gv-worker compiles clean. No embedded test page routes. `handle_index` still serves /.

---

## Verification

```bash
# Build and test
scripts/dev-start.sh build
scripts/dev-start.sh start

# Verify modal quick-play still works
curl -s http://localhost:3000/ | grep -c "Play"  # play buttons present

# Verify /play page with back button
curl -s "http://localhost:3000/play/test-game?server_id=..." | grep -c "Back\|←"

# Verify expired session recovery
# (manual: share link → kill worker → click link → see "Start new session")

# Run tests
npx vitest run  # gv-web tests pass
cargo test -p gv-worker -- --skip sdp_handshake  # gv-worker tests pass
```
