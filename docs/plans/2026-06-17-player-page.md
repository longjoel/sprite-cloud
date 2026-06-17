# Production Game Player Page — Implementation Plan (#156)

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Navigate from library "Play" to a dedicated full-screen player at `/play/:game_id` instead of opening a modal overlay.

**Architecture:** The page (`/play/[game_id]/page.tsx`) already exists for deep-link joins. Task 1 wires navigation from LibraryClient. Task 2 adds back-navigation. Task 3 adds server-side validation. Task 4 removes the modal code.

**Tech Stack:** Next.js (App Router), React, TypeScript, existing GvPlayer/play.js WebRTC stack

**Current state:** The player UI (GamePlayer.tsx, 595 lines), connection glue (play.js, 283 lines), and WebRTC class (index.js, 925 lines) are fully built. The library opens GamePlayer in a modal overlay via `activeGame` state. The `/play/:game_id` page handles `?join=` (guest links) and `?server_id=` params but has no back-navigation.

---

## Tasks

### Task 1: Navigate library "Play" to /play page

**Objective:** Replace modal overlay with Next.js App Router navigation.

**Files:**
- Modify: `gv-web/components/LibraryClient.tsx`

**What to do:**

1. Import `useRouter` from `next/navigation`:
```tsx
import { useRouter } from "next/navigation";
```

2. Add router to component:
```tsx
const router = useRouter();
```

3. Replace the `handlePlay` function's auto-select path (line 115-121). Currently:
```tsx
if (withGame.length === 1) {
  setSelectedServerId(withGame[0].server_id);
  const name = hosts.find(...)?.name || "";
  setPreferredServer(gameId, withGame[0].server_id);
  setActiveGame({ id: gameId, name });
  return;
}
```
Change to:
```tsx
if (withGame.length === 1) {
  setPreferredServer(gameId, withGame[0].server_id);
  router.push(`/play/${gameId}?server_id=${withGame[0].server_id}`);
  return;
}
```

4. Replace `selectHost` function (line 131-136). Currently:
```tsx
const selectHost = (gameId: string, serverId: string, serverName: string) => {
  setSelectedServerId(serverId);
  setHostPickerGame(null);
  setPreferredServer(gameId, serverId);
  setActiveGame({ id: gameId, name: serverName });
};
```
Change to:
```tsx
const selectHost = (gameId: string, serverId: string) => {
  setHostPickerGame(null);
  setPreferredServer(gameId, serverId);
  router.push(`/play/${gameId}?server_id=${serverId}`);
};
```

5. Update the host picker button's `onClick` handler (around line 230) to call `selectHost(hostPickerGame!, host.server_id)` (remove `host.name` param).

**Acceptance:** Clicking "Play" on a game with one server navigates to `/play/:game_id?server_id=...`. Multi-server games show picker; clicking "Select" navigates.

---

### Task 2: Remove modal + unused state

**Objective:** Clean up LibraryClient — remove inline player modal and dead state.

**Files:**
- Modify: `gv-web/components/LibraryClient.tsx`

**What to do:**

1. Remove `selectedServerId` state (line 68):
```tsx
// DELETE: const [selectedServerId, setSelectedServerId] = useState<string | null>(null);
```

2. Remove `activeGame` state (line 69):
```tsx
// DELETE: const [activeGame, setActiveGame] = useState<{ id: string; name: string } | null>(null);
```

3. Remove the modal overlay (lines 254-266):
```tsx
// DELETE entire block:
// {activeGame && selectedServerId && (
//   <div style={styles.modalOverlay}>...
// )}
```

4. Remove `GamePlayer` import (line 6):
```tsx
// DELETE: import GamePlayer from "@/components/GamePlayer";
```

**Acceptance:** `LibraryClient.tsx` compiles clean. No unused imports. No `GamePlayer` or modal references remain.

---

### Task 3: Add "Back to Library" on /play page

**Objective:** When arriving from the library (not a guest join link), show a back button.

**Files:**
- Modify: `gv-web/app/play/[game_id]/page.tsx`

**What to do:**

1. Import `useRouter`:
```tsx
import { useRouter } from "next/navigation";
```

2. Add router:
```tsx
const router = useRouter();
```

3. Pass an `onClose` callback to GamePlayer that navigates back:
```tsx
<GamePlayer
  gameId={gameId}
  serverId={resolvedServerId}
  onClose={() => router.push("/")}
/>
```

This works because GamePlayer already has an `onClose` prop that renders a "← Back" button in the top bar (line 341-345 of GamePlayer.tsx).

**Acceptance:** /play page shows "← Back" button. Clicking it navigates to library. The button should NOT show for guest joins (no `serverId` or `join` only) — but in practice, `onClose` renders the button regardless, which is fine UX (always have a way out).

---

### Task 4: Add server-side validation for play page

**Objective:** If `server_id` is provided, validate the server exists, is online, and has the requested game before showing the player.

**Files:**
- Modify: `gv-web/app/play/[game_id]/page.tsx`

**What to do:**

1. Add a `useEffect` that validates the server+game when `serverId` is provided:
```tsx
const [validating, setValidating] = useState(!!serverId);
const [serverError, setServerError] = useState<string | null>(null);

useEffect(() => {
  if (!serverId || !gameId) return;
  
  (async () => {
    try {
      const resp = await fetch(`/api/playable-hosts?game_id=${encodeURIComponent(gameId)}`);
      if (!resp.ok) {
        setServerError("Failed to check server status");
        return;
      }
      const data = await resp.json();
      const host = (data.hosts || []).find((h: any) => h.server_id === serverId);
      if (!host) {
        setServerError("Server not found");
        return;
      }
      if (!host.has_game) {
        setServerError(`Game not available on this server`);
        return;
      }
      if (host.status === "offline") {
        setServerError("Server is offline");
        return;
      }
    } catch {
      setServerError("Network error checking server");
    } finally {
      setValidating(false);
    }
  })();
}, [serverId, gameId]);
```

2. Show loading/error states between the existing join-flow error and the GamePlayer render:
```tsx
if (validating) {
  return (
    <main style={{ ...styles.shell, background: "var(--color-mahogany)" }}>
      <div style={styles.center}>
        <p style={styles.text}>Checking server status…</p>
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

**Acceptance:** Browsing to `/play/:game_id?server_id=bogus` shows error. Valid server+game shows player. Guest joins (`?join=...`) skip validation entirely (correct — session already exists).

---

### Task 5: Remove embedded test page fallback

**Objective:** The gv-worker embedded test page (`build_index_html`) is dead code — remove it.

**Files:**
- Modify: `gv-worker/src/main_body.rs`

**What to do:**

1. Remove the `build_index_html` function and its handler:
   - Delete `handle_player_index` function
   - Delete `handle_player_js` function  
   - Delete `build_index_html` function
   - Remove the route registrations for these handlers

2. Remove the `SEAT` constant at the top of the handler section.

3. Keep `handle_index` for the minimal health page.

**Acceptance:** `gv-worker` compiles clean. No embedded test page routes. `handle_index` still works for `/healthz`.

---

## Verification

```bash
# Build and test
scripts/dev-start.sh build
scripts/dev-start.sh start

# Verify navigation
curl -s http://localhost:3000/ | grep -c "play"  # library renders
# Manual: click "Play" on a scanned game → navigates to /play/:game_id
# Manual: "← Back" button returns to library

# Verify error states
curl -s "http://localhost:3000/play/fake-game?server_id=fake-server" | grep -c "not found\|offline\|error"

# Verify guest join still works
curl -s "http://localhost:3000/play/any-game?join=bogus-token" | grep -c "Joining\|error"

# Run tests
cargo test -p gv-worker -- --skip sdp_handshake  # Rust tests pass
npx vitest run  # gv-web tests pass
```
