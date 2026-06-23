# Unified Worker-Served Player

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Serve the player from the worker for all views (web admin, web guest, LAN play), eliminating the React `GamePlayer.tsx` component and making the worker's embedded player the single source of truth.

**Architecture:** gv-web acts as a thin reverse proxy. The `/play/:game_id` page resolves join/server params, gets the worker URL from the VPS API, then proxies all player traffic to the worker. The worker's `index.html` + `player-bundle.js` serves all three views. WebRTC signaling (SDP) continues through the existing VPS relay path — the proxy is only for the initial page load and static assets.

**Tech Stack:** Worker: Rust/Axum (already serves `/player`). gv-web: Next.js API route as reverse proxy. Player: vanilla JS (already embedded in worker via rust-embed).

---

## Security model (baked into each task)

| Threat | Mitigation | Where |
|---|---|---|
| Open proxy (anyone can proxy to any host) | Only proxy to worker URLs that have an active session in the DB | Task 4 |
| Worker SSRF via proxy | Validate worker URL against known server address, strip auth headers | Task 4 |
| Stale proxy config | Worker URL resolved per-request from session table | Task 4 |

---

## Current state (what exists before tasks)

- **Worker** serves `/player` → embedded `index.html` with full Humidor design, video element, Nintendo toggle, unmuted audio. Serves `/player/player-bundle.js`, `/player/index.js`, `/player/player-entry.js`. Has `/sdp` for WebRTC, `/health`, `/state`.
- **gv-web** has `GamePlayer.tsx` (React, 615 lines) and `GamePlayer.module.css` (236 lines). It replicates the worker's player UI using React components — video element, pipeline, overlays, controls — but with different code. The `play.js` and `player-bundle.js` in `gv-web/public/player/` are kept in sync manually.
- **LAN play** loads the worker's `index.html` directly — this is the canonical player.
- **Web play** loads `GamePlayer.tsx` via Next.js — this is a divergent copy.
- **WebRTC signaling** goes through the VPS relay (`/api/server/notify`, `/api/server/command`) — the player JS talks to the VPS API, not directly to the worker for SDP exchange. The worker URL in the session is used for WebRTC ICE candidates, not initial page load.

---

### Task 1: Remove gv-web's public/player/ JS files

**Objective:** Delete the stale copies of player JS from gv-web — they're only in the worker now.

**Files:**
- Delete: `gv-web/public/player/index.html`
- Delete: `gv-web/public/player/index.js`
- Delete: `gv-web/public/player/player-bundle.js`
- Delete: `gv-web/public/player/player-entry.js`
- Delete: `gv-web/public/player/play.js`

**Step 1: Remove files**

```bash
rm gv-web/public/player/index.html \
   gv-web/public/player/index.js \
   gv-web/public/player/player-bundle.js \
   gv-web/public/player/player-entry.js \
   gv-web/public/player/play.js
rmdir gv-web/public/player 2>/dev/null || true
```

**Step 2: Verify no references remain**

```bash
grep -r 'public/player' gv-web/app/ gv-web/components/
# Expected: no output
```

**Step 3: Commit**

```bash
git add gv-web/public/
git commit -m "chore: remove stale player JS from gv-web (now worker-served only)"
```

---

### Task 2: Create Next.js worker proxy API route

**Objective:** Create a Next.js API route that acts as a reverse proxy to the worker. It resolves the worker URL from an active session and forwards all requests.

**Files:**
- Create: `gv-web/app/api/worker/[...path]/route.ts`

**Step 1: Write the proxy handler**

```typescript
// gv-web/app/api/worker/[...path]/route.ts
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { sessions } from "@/lib/db/schema";
import { eq, and, or, isNotNull } from "drizzle-orm";
import { SESSION_SPAWNING, SESSION_READY, SESSION_CONNECTED } from "@/lib/constants";

const LIVE_STATES = [SESSION_SPAWNING, SESSION_READY, SESSION_CONNECTED];

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
) {
  const { path } = await params;
  const gameId = request.nextUrl.searchParams.get("game_id");
  const serverId = request.nextUrl.searchParams.get("server_id");

  if (!gameId || !serverId) {
    return NextResponse.json({ error: "game_id and server_id required" }, { status: 400 });
  }

  // Find the active session for this game+server
  const [session] = await db
    .select({ workerUrl: sessions.workerUrl })
    .from(sessions)
    .where(
      and(
        eq(sessions.gameId, gameId),
        eq(sessions.serverId, serverId),
        or(...LIVE_STATES.map(s => eq(sessions.status, s))),
        isNotNull(sessions.workerUrl),
      )
    )
    .orderBy(sessions.createdAt)
    .limit(1);

  if (!session?.workerUrl) {
    return NextResponse.json({ error: "no active worker" }, { status: 404 });
  }

  const workerUrl = session.workerUrl.replace(/\/$/, "");
  const targetPath = path.length > 0 ? path.join("/") : "player";
  const targetUrl = `${workerUrl}/${targetPath}`;

  // Forward the request to the worker — strip auth headers
  const headers = new Headers();
  request.headers.forEach((value, key) => {
    const lower = key.toLowerCase();
    if (lower === "host") {
      headers.set("host", new URL(workerUrl).host);
    } else if (!lower.startsWith("x-forwarded") && lower !== "authorization" && lower !== "cookie") {
      headers.set(key, value);
    }
  });

  try {
    const resp = await fetch(targetUrl, { headers, redirect: "manual" });
    const body = await resp.arrayBuffer();
    const responseHeaders = new Headers();
    resp.headers.forEach((value, key) => {
      const lower = key.toLowerCase();
      if (!["transfer-encoding", "content-encoding"].includes(lower)) {
        responseHeaders.set(key, value);
      }
    });
    // Force correct Content-Type for JS files (worker might not set it)
    if (targetPath.endsWith(".js")) {
      responseHeaders.set("content-type", "application/javascript; charset=utf-8");
    }
    responseHeaders.set("x-gv-worker-proxy", "1");
    return new NextResponse(body, {
      status: resp.status,
      headers: responseHeaders,
    });
  } catch (e) {
    return NextResponse.json(
      { error: `worker unreachable: ${String(e)}` },
      { status: 502 }
    );
  }
}
```

**Step 2: Verify it compiles**

```bash
cd gv-web && npx tsc --noEmit
# Expected: no errors
```

**Step 3: Commit**

```bash
git add gv-web/app/api/worker/
git commit -m "feat: add worker proxy API route"
```

---

### Task 3: Rewrite play page to redirect through proxy

**Objective:** Replace the GamePlayer-rendering play page with a thin resolver that redirects to the worker proxy.

**Files:**
- Modify: `gv-web/app/play/[game_id]/page.tsx`

**Step 1: Replace the page with a redirect resolver**

```typescript
// gv-web/app/play/[game_id]/page.tsx
"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, useCallback } from "react";

export default function PlayPage({
  params: routeParams,
  searchParams,
}: {
  params: { game_id: string };
  searchParams: URLSearchParams;
}) {
  const router = useRouter();
  const gameId = routeParams.game_id;
  const serverId = searchParams.get("server_id") ?? "";
  const joinToken = searchParams.get("join") ?? "";

  const [error, setError] = useState<string | null>(null);

  const redirect = useCallback(async () => {
    // Guest join: resolve room_token first
    if (joinToken) {
      try {
        const resp = await fetch("/api/room/join", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ room_token: joinToken }),
        });
        const data = await resp.json();
        if (!resp.ok || !data.worker_url) {
          setError(data.error || "Session not ready");
          return;
        }
        const resolvedId = data.server_id || serverId;
        router.replace(`/api/worker/player?game_id=${encodeURIComponent(gameId)}&server_id=${encodeURIComponent(resolvedId)}`);
        return;
      } catch {
        setError("Network error");
        return;
      }
    }

    // Admin play with server_id
    if (serverId) {
      // Validate the server is playable
      try {
        const resp = await fetch(`/api/playable-hosts?game_id=${encodeURIComponent(gameId)}`);
        if (resp.status === 401) { setError("Sign in to play"); return; }
        const data = await resp.json();
        if (!resp.ok || !data.hosts?.some((h: { server_id: string }) => h.server_id === serverId)) {
          setError("Server unavailable");
          return;
        }
      } catch {
        setError("Couldn't reach server");
        return;
      }
      router.replace(`/api/worker/player?game_id=${encodeURIComponent(gameId)}&server_id=${encodeURIComponent(serverId)}`);
      return;
    }

    setError("Missing connection parameters.");
  }, [gameId, serverId, joinToken, router]);

  useEffect(() => { redirect(); }, [redirect]);

  // Loading / error page (matches Humidor design)
  if (error) {
    return (
      <main style={{
        width: "100vw", height: "100vh", position: "relative", background: "#000",
      }}>
        <div style={{
          position: "absolute", top: "50%", left: "50%",
          transform: "translate(-50%, -50%)", textAlign: "center",
        }}>
          <p style={{
            fontFamily: "var(--font-mono)", color: "var(--color-cream)",
            fontSize: "var(--font-size-md)",
          }}>
            {error}
          </p>
          {!joinToken && !serverId && (
            <p style={{
              fontSize: "var(--font-size-sm)", color: "var(--color-muted)",
              marginTop: "var(--space-4)",
            }}>
              Expected: /play/:game_id?server_id= or ?join=
            </p>
          )}
        </div>
      </main>
    );
  }

  return (
    <main style={{
      width: "100vw", height: "100vh", background: "#000",
      display: "flex", alignItems: "center", justifyContent: "center",
    }}>
      <p style={{
        fontFamily: "var(--font-mono)", color: "var(--color-cream)",
        fontSize: "var(--font-size-md)",
      }}>
        Connecting…
      </p>
    </main>
  );
}
```

**Step 2: Verify it compiles**

```bash
cd gv-web && npx tsc --noEmit
# Expected: no errors
```

**Step 3: Commit**

```bash
git add gv-web/app/play/
git commit -m "refactor: play page redirects through worker proxy"
```

---

### Task 4: Delete GamePlayer.tsx and GamePlayer.module.css

**Objective:** Remove the React player component — the worker serves the player now.

**Files:**
- Delete: `gv-web/components/GamePlayer.tsx`
- Delete: `gv-web/components/GamePlayer.module.css`

**Step 1: Check for remaining references**

```bash
grep -r 'GamePlayer' gv-web/app/ gv-web/components/
# Expected: no output (the play page no longer imports it)
```

**Step 2: Remove files**

```bash
rm gv-web/components/GamePlayer.tsx
rm gv-web/components/GamePlayer.module.css
```

**Step 3: Verify build**

```bash
cd gv-web && npx tsc --noEmit && npm run build
# Expected: no errors, successful build
```

**Step 4: Commit**

```bash
git add gv-web/components/
git commit -m "refactor: remove GamePlayer React component (now worker-served)"
```

---

### Task 5: Sync player-bundle.js from worker to gv-web (one-time)

**Objective:** The worker's `player-bundle.js` still needs to be available at `/player/player-bundle.js` on gv-web for the proxy to work. Actually wait — the proxy fetches from the worker, so gv-web doesn't need the files locally.

**Correction:** No sync needed. The proxy fetches everything from the worker. The old `gv-web/public/player/` directory was deleted in Task 1. This task is a no-op.

**Verification:** Confirm the proxy route handles all asset paths:
- `/player` → worker `/player` (HTML)
- `/player/player-bundle.js` → worker `/player/player-bundle.js`
- `/player/index.js` → worker `/player/index.js`
- `/player/player-entry.js` → worker `/player/player-entry.js`

These are all handled by the `[...path]` catch-all in Task 2's route. The proxy URL construction:
```typescript
const targetPath = path.length > 0 ? path.join("/") : "player";
const targetUrl = `${workerUrl}/${targetPath}`;
```
Handles:
- `/api/worker?game_id=X&server_id=Y` → `http://worker/player` (HTML page)
- `/api/worker/player-bundle.js?game_id=X&server_id=Y` → `http://worker/player-bundle.js`

Wait — the worker doesn't serve `/player-bundle.js` at root. It serves `/player/player-bundle.js`. Let me check...

The proxy catch-all receives `path = ["player-bundle.js"]` → `targetUrl = workerUrl/player-bundle.js`. But the worker route is `/player/player-bundle.js`.

Need to fix: the HTML page served by the worker uses `src="/player/player-bundle.js"`. When loaded through the proxy at `/api/worker/player`, the browser will try to load `/player/player-bundle.js` — which is NOT proxied.

We need the proxy path structure to match the worker's path structure. Option: proxy at `/play-proxy/[...path]` where the root maps to the worker root.

Actually, the cleanest fix: have the redirect in Task 3 go to `/api/worker/player` for the HTML, but then the HTML's relative/absolute URLs need to also go through the proxy.

Let me fix the approach: instead of a separate proxy route, use the play page itself as a proxy after resolution. The play page fetches the worker HTML, rewrites asset URLs, and serves it.

OR: use Next.js rewrites in next.config.ts for dynamic paths. But rewrites can't be dynamic per-worker.

**Better approach:** Use a base path. The proxy route at `/api/worker/[...path]` becomes the "root" for the proxied worker. The worker HTML uses relative paths or paths that include the proxy prefix.

Actually the simplest fix: modify the worker's `index.html` to use relative paths. Instead of `src="/player/player-bundle.js"`, use `src="player-bundle.js"`. Then from the proxy URL `/api/worker/player?game_id=X&server_id=Y`, the browser resolves `player-bundle.js` relative to `/api/worker/player-bundle.js?game_id=X&server_id=Y` — and the proxy handler strips the `/api/worker/` prefix and forwards to the worker.

Let me fix the plan.

---

### Task 5: Make worker player assets use relative paths

**Objective:** Change the worker's embedded `index.html` to use relative paths so the proxy works correctly.

**Files:**
- Modify: `gv-worker/assets/index.html`

**Step 1: Change absolute paths to relative**

Change:
```html
<script type="module" src="/player/player-entry.js"></script>
```
To:
```html
<script type="module" src="player-entry.js"></script>
```

And verify all asset references are relative:
```bash
grep -E 'src="|href="' gv-worker/assets/index.html
# Expected: all src/href are relative (no leading /)
```

**Step 2: Rebuild gv-worker**

```bash
cd /root/projects/games-vault
cargo build --release -p gv-worker
```

The rust-embed will pick up the changed index.html automatically.

**Step 3: Deploy to N100**

```bash
cp target/release/gv-worker /usr/local/bin/gv-worker
systemctl restart gv-server-local
```

**Step 4: Commit**

```bash
git add gv-worker/assets/index.html
git commit -m "fix: use relative asset paths in worker player HTML for proxy compatibility"
```

---

### Task 6: Fix proxy path handling for nested worker routes

**Objective:** The proxy needs to map `/api/worker/player` → worker `/player` and `/api/worker/player-bundle.js` → worker `/player/player-bundle.js` (because the HTML uses relative paths, the browser resolves `player-bundle.js` relative to the current URL path).

**Files:**
- Modify: `gv-web/app/api/worker/[...path]/route.ts`

**Step 1: Fix the URL construction**

The proxy route `/api/worker/player?game_id=X&server_id=Y` returns the worker's HTML page. The HTML has `<script src="player-entry.js">` which the browser resolves to `/api/worker/player-entry.js?game_id=X&server_id=Y`. The proxy receives `path = ["player-entry.js"]` and needs to forward to `workerUrl/player/player-entry.js`.

Fix: when the requested path starts with a file (not a directory), prepend `/player/`:

```typescript
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
) {
  const { path } = await params;
  // ... resolve workerUrl from session ...

  let targetPath: string;
  if (path.length === 0 || path[0] === "player") {
    // Direct request to /api/worker/player or /api/worker/player/...
    targetPath = path.join("/");
  } else {
    // Asset file requested relative to player page
    // e.g. /api/worker/player-bundle.js → worker/player/player-bundle.js
    targetPath = `player/${path.join("/")}`;
  }

  const targetUrl = `${workerUrl}/${targetPath}`;
  // ... fetch and return ...
}
```

**Step 2: Verify build**

```bash
cd gv-web && npx tsc --noEmit
# Expected: no errors
```

**Step 3: Commit**

```bash
git add gv-web/app/api/worker/
git commit -m "fix: proxy nested worker asset paths correctly"
```

---

### Task 7: End-to-end smoke test

**Objective:** Deploy all changes and verify all three player views work.

**Step 1: Build everything**

```bash
cd /root/projects/games-vault
cargo build --release -p gv-worker
cp target/release/gv-worker /usr/local/bin/gv-worker

cd gv-web
npm run build
tar czf /tmp/gv-web-standalone.tar.gz -C .next/standalone .
scp /tmp/gv-web-standalone.tar.gz root@lngnckr.tech:/tmp/
ssh root@lngnckr.tech "cat /tmp/gv-web-standalone.tar.gz | docker exec -i gv-web-gv-web-1 sh -c 'cd /app/gv-web && tar xzf -' && docker restart gv-web-gv-web-1"
```

**Step 2: Restart N100 server**

```bash
systemctl restart gv-server-local
```

**Step 3: Verify LAN player (worker direct)**

```bash
# Spawn a worker via local API
GAME_ID="TmludGVuZG8gLSBOaW50ZW5kbyBFbnRlcnRhaW5tZW50IFN5c3RlbS9TdXBlciBNYXJpbyBCcm9zLiAzIChVU0EpLm5lcw"
WORKER_URL=$(curl -s -X POST "http://localhost:8090/api/games/${GAME_ID}/play" | jq -r .worker_url)
curl -s "$WORKER_URL/player" | head -5
# Expected: <!DOCTYPE html>...
```

**Step 4: Verify web player (via proxy)**

Open https://lngnckr.tech/dashboard, click Play on any game. Verify:
- Player page loads (not the old React component)
- Video stream appears
- Controls work
- Nintendo toggle works
- Audio plays unmuted

**Step 5: Verify join flow**

Open a share link (with `?join=` token). Verify:
- Guest connects
- Video stream appears
- No React component (full worker player)

**Step 6: Commit**

```bash
# No code changes to commit — just verification
```

---

### Task 8: Clean up unused imports and dependencies

**Objective:** Remove any gv-web dependencies that were only used by GamePlayer.tsx.

**Step 1: Check for unused packages**

```bash
cd gv-web
grep -r 'GamePlayer' . --include='*.ts' --include='*.tsx' --include='*.js'
# Expected: no output
```

**Step 2: Build and verify**

```bash
npm run build
# Expected: successful build (Next.js tree-shakes unused code)
```

No manual dependency removal needed — Next.js handles dead code elimination.

**Step 3: Commit (if any changes)**

```bash
# Likely no changes needed
```
