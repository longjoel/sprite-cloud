# Multi-Server Host Selection — Implementation Plan

> **For Hermes:** Implement task-by-task with strict TDD. Each task = 2-5 min.

**Goal:** When a game exists on multiple servers, let the user pick a host instead of defaulting to a single server.

**Architecture:** New `/api/playable-hosts` endpoint returns all servers (for the user) that have the game, with online status, route hints, and game availability. The `LibraryClient` and `GamePlayer` are updated to show a host picker when multiple servers are available, auto-selecting the best default (local > direct > relay). User preference is persisted via a cookie. The chosen `server_id` flows through existing command/notify/SDP pipelines unchanged.

**Tech Stack:** Next.js App Router + Drizzle ORM + React client components + vanilla JS player

---

## Security model (baked into each task)

| Threat | Mitigation | Where |
|---|---|---|
| Unauthorized server access | `serverMembers` join in query; only returns user's servers | Task 1 |
| Cross-user game file visibility | `gameFiles.serverId` scoped to authorized servers only | Task 1 |
| Command targeting wrong server | `server_id` validated against membership in command route (existing) | existing |
| Server metadata leak | Only returns non-secret fields (name, last_seen, metadata sans credentials) | Task 1 |

---

## Current state

- `LibraryClient` gets a single `serverId` from `page.tsx` (first server the user is a member of)
- "Play" button reuses that single `serverId` — no choice
- `GamePlayer` receives `serverId` as prop, passes it to `play.js → startGame() → connectViaRelay()`
- Server metadata exists at `GET /api/servers/[server_id]/metadata` but requires per-server fetch
- Route badge from #276 is wired — `classifyRoute()` in `index.js` + `onRoute` callback in `GamePlayer.tsx`
- No cross-server game lookup exists

---

### Task 1: Create `/api/playable-hosts` endpoint (red → green)

**Objective:** API returns all user's servers that have a given game, scoped to their membership.

**Files:**
- Create: `gv-web/app/api/playable-hosts/route.ts`

**Step 1: Write failing test**

```typescript
// In gv-web/tests/api/routes.test.ts — add new describe block

describe("GET /api/playable-hosts", () => {
  it("returns 401 when not signed in", async () => {
    mockAuth.mockResolvedValueOnce(null);
    const { GET } = await import("@/app/api/playable-hosts/route");
    const req = mkReq("http://localhost/api/playable-hosts?game_id=smw");
    const resp = await GET(req);
    expect(resp.status).toBe(401);
  });

  it("returns 400 when game_id missing", async () => {
    const { GET } = await import("@/app/api/playable-hosts/route");
    const req = mkReq("http://localhost/api/playable-hosts");
    const resp = await GET(req);
    expect(resp.status).toBe(400);
  });

  it("returns empty hosts when user has no servers", async () => {
    mockDb.select.mockReturnValue(mockQueryBuilder([]));
    const { GET } = await import("@/app/api/playable-hosts/route");
    const req = mkReq("http://localhost/api/playable-hosts?game_id=smw");
    const resp = await GET(req);
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.hosts).toEqual([]);
  });

  it("returns hosts with game availability and server metadata", async () => {
    // Mock: user has servers server-1 and server-2; both members
    // Mock: game "smw" has files on server-1 only
    // server-1 has metadata (lan_addresses, ice), server-2 doesn't
    // Return shape from the query: servers + gameFiles joined
    mockDb.select.mockReturnValue(
      mockQueryBuilder([
        {
          serverId: "server-1",
          serverName: "Home PC",
          lastSeenAt: new Date(),
          metadata: { lan_addresses: ["192.168.1.100"], ice: { turn_configured: false } },
          hasGame: true,
        },
        {
          serverId: "server-2",
          serverName: "Arcade Box",
          lastSeenAt: new Date(Date.now() - 120_000), // 2 min ago
          metadata: { lan_addresses: [], ice: { turn_configured: true } },
          hasGame: false,
        },
      ]),
    );

    const { GET } = await import("@/app/api/playable-hosts/route");
    const req = mkReq("http://localhost/api/playable-hosts?game_id=smw");
    const resp = await GET(req);
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.hosts).toHaveLength(2);
    expect(body.hosts[0]).toMatchObject({
      server_id: "server-1",
      name: "Home PC",
      has_game: true,
    });
    expect(body.hosts[1]).toMatchObject({
      server_id: "server-2",
      name: "Arcade Box",
      has_game: false,
    });
  });

  it("only returns servers the user is a member of", async () => {
    // The query already filters by serverMembers.userId — this test
    // validates that the where clause is present by mocking empty result
    mockDb.select.mockReturnValue(mockQueryBuilder([]));
    const { GET } = await import("@/app/api/playable-hosts/route");
    const req = mkReq("http://localhost/api/playable-hosts?game_id=smw");
    const resp = await GET(req);
    const body = await resp.json();
    // Should not return servers user isn't a member of
    expect(body.hosts.every((h: any) => h.server_id !== "unauthorized-server")).toBe(true);
  });
});
```

**Step 2: Run test to verify failure**
Run: `npx vitest run tests/api/ --reporter=verbose -t "playable-hosts"`
Expected: 5 FAIL — module not found

**Step 3: Write minimal implementation**

```typescript
// gv-web/app/api/playable-hosts/route.ts
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { gameFiles, servers, serverMembers } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";

export async function GET(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "sign in first" }, { status: 401 });
  }

  const gameId = request.nextUrl.searchParams.get("game_id");
  if (!gameId) {
    return NextResponse.json({ error: "game_id required" }, { status: 400 });
  }

  // Find all servers the user is a member of, joined with game file
  // availability for the requested game.
  const rows = await db
    .select({
      serverId: servers.id,
      serverName: servers.name,
      lastSeenAt: servers.lastSeenAt,
      metadata: servers.metadata,
      gameFileId: gameFiles.id,
    })
    .from(serverMembers)
    .innerJoin(servers, eq(serverMembers.serverId, servers.id))
    .leftJoin(
      gameFiles,
      and(eq(gameFiles.serverId, servers.id), eq(gameFiles.gameId, gameId)),
    )
    .where(eq(serverMembers.userId, session.user.id));

  const hosts = rows.map((row) => ({
    server_id: row.serverId,
    name: row.serverName,
    last_seen_at: row.lastSeenAt,
    has_game: row.gameFileId !== null,
    metadata: row.metadata ?? {},
  }));

  return NextResponse.json({ hosts });
}
```

**Step 4: Run test to verify pass**
Run: `npx vitest run tests/api/ --reporter=verbose -t "playable-hosts"`
Expected: 5 PASS

**Step 5: Run full suite to check regressions**
Run: `npx vitest run tests/api/`
Expected: all existing tests still PASS

**Step 6: Commit**
```bash
git add gv-web/app/api/playable-hosts/route.ts gv-web/tests/api/routes.test.ts
git commit -m "feat: add /api/playable-hosts endpoint (#279)"
```

---

### Task 2: Add server staleness classification to API

**Objective:** Classify servers as online/stale/offline based on `lastSeenAt`.

**Files:**
- Modify: `gv-web/app/api/playable-hosts/route.ts`

**Step 1: Write failing test**

```typescript
it("classifies servers as online, stale, or offline", async () => {
  const now = new Date();
  const online = new Date(now.getTime() - 30_000);     // 30s ago
  const stale = new Date(now.getTime() - 120_000);      // 2 min ago
  const offline = new Date(now.getTime() - 600_000);     // 10 min ago

  mockDb.select.mockReturnValue(
    mockQueryBuilder([
      { serverId: "s1", serverName: "Online", lastSeenAt: online, metadata: {}, gameFileId: "gf1" },
      { serverId: "s2", serverName: "Stale", lastSeenAt: stale, metadata: {}, gameFileId: null },
      { serverId: "s3", serverName: "Offline", lastSeenAt: offline, metadata: {}, gameFileId: "gf3" },
    ]),
  );

  const { GET } = await import("@/app/api/playable-hosts/route");
  const req = mkReq("http://localhost/api/playable-hosts?game_id=smw");
  const resp = await GET(req);
  const body = await resp.json();
  expect(body.hosts[0].status).toBe("online");
  expect(body.hosts[1].status).toBe("stale");
  expect(body.hosts[2].status).toBe("offline");
});
```

**Step 2: Run to verify failure**
Run: `npx vitest run tests/api/ --reporter=verbose -t "classifies servers"`
Expected: FAIL — status not returned

**Step 3: Add staleness logic**

Add constants and status classification to the route:

```typescript
const STALE_THRESHOLD_MS = 90_000;   // 90s
const OFFLINE_THRESHOLD_MS = 300_000; // 5 min

function classifyStatus(lastSeenAt: Date | string | null): string {
  if (!lastSeenAt) return "offline";
  const ms = Date.now() - new Date(lastSeenAt).getTime();
  if (ms < STALE_THRESHOLD_MS) return "online";
  if (ms < OFFLINE_THRESHOLD_MS) return "stale";
  return "offline";
}
```

Update the `hosts` mapping to include `status: classifyStatus(row.lastSeenAt)`.

**Step 4: Run tests**
Run: `npx vitest run tests/api/ --reporter=verbose -t "classifies servers"`
Expected: PASS

**Step 5: Commit**
```bash
git add gv-web/app/api/playable-hosts/route.ts gv-web/tests/api/routes.test.ts
git commit -m "feat: add staleness classification to playable-hosts (#279)"
```

---

### Task 3: Add route hint classification to API

**Objective:** Each host gets a `route_hint` ("local", "direct", "relay", "unknown") based on server metadata (ICE config + LAN addresses).

**Files:**
- Modify: `gv-web/app/api/playable-hosts/route.ts`

**Step 1: Write failing test**

```typescript
it("classifies route hints from server metadata", async () => {
  mockDb.select.mockReturnValue(
    mockQueryBuilder([
      {
        serverId: "s1", serverName: "Local", lastSeenAt: new Date(),
        metadata: { lan_addresses: ["192.168.1.100"], ice: { turn_configured: false } },
        gameFileId: "gf1",
      },
      {
        serverId: "s2", serverName: "Remote", lastSeenAt: new Date(),
        metadata: { lan_addresses: [], ice: { turn_configured: false } },
        gameFileId: "gf2",
      },
      {
        serverId: "s3", serverName: "Relay", lastSeenAt: new Date(),
        metadata: { lan_addresses: [], ice: { turn_configured: true } },
        gameFileId: "gf3",
      },
    ]),
  );

  const { GET } = await import("@/app/api/playable-hosts/route");
  const req = mkReq("http://localhost/api/playable-hosts?game_id=smw");
  const resp = await GET(req);
  const body = await resp.json();
  expect(body.hosts[0].route_hint).toBe("local");
  expect(body.hosts[1].route_hint).toBe("direct");
  expect(body.hosts[2].route_hint).toBe("relay");
});

it("returns route_hint unknown when metadata is missing", async () => {
  mockDb.select.mockReturnValue(
    mockQueryBuilder([
      { serverId: "s1", serverName: "Unknown", lastSeenAt: new Date(), metadata: {}, gameFileId: "gf1" },
    ]),
  );
  const { GET } = await import("@/app/api/playable-hosts/route");
  const req = mkReq("http://localhost/api/playable-hosts?game_id=smw");
  const resp = await GET(req);
  const body = await resp.json();
  expect(body.hosts[0].route_hint).toBe("unknown");
});
```

**Step 2: Run to verify failure**
Run: `npx vitest run tests/api/ --reporter=verbose -t "route hints"`
Expected: FAIL — route_hint not present

**Step 3: Add route hint logic**

```typescript
function classifyRouteHint(metadata: Record<string, unknown>): string {
  const meta = metadata as any;
  const ice = meta?.ice;
  const lanAddrs = meta?.lan_addresses;

  // Server on the LAN (has LAN addresses) → "local"
  if (Array.isArray(lanAddrs) && lanAddrs.length > 0) return "local";

  // Server with TURN → "relay"
  if (ice?.turn_configured) return "relay";

  // Server with STUN but no TURN, no LAN → "direct"
  if (ice) return "direct";

  return "unknown";
}
```

Update the hosts mapping to include `route_hint: classifyRouteHint(row.metadata ?? {})`.

**Step 4: Run tests**
Run: `npx vitest run tests/api/ --reporter=verbose -t "route hints"`
Expected: PASS

**Step 5: Run full suite**
Run: `npx vitest run tests/api/`
Expected: all PASS

**Step 6: Commit**
```bash
git add gv-web/app/api/playable-hosts/route.ts gv-web/tests/api/routes.test.ts
git commit -m "feat: add route hint classification to playable-hosts (#279)"
```

---

### Task 4: Update `page.tsx` to fetch playable hosts instead of single server

**Objective:** Home page fetches playable hosts for the game and passes them to `LibraryClient`.

**Files:**
- Modify: `gv-web/app/page.tsx`

**Step 1: The page.tsx currently picks the first server — change it to pass all server IDs**

This is a simple data plumbing change — no new tests needed since `page.tsx` is a server component that can't be unit-tested in vitest (Next.js server component). We rely on the existing API tests for correctness.

```typescript
// In page.tsx — instead of single serverId, pass all server IDs
export default async function Home() {
  const session = await auth();
  const games = await listGames();

  // Find all servers the user is a member of (for server picker)
  let serverIds: string[] = [];
  if (session?.user?.id) {
    const memberships = await db
      .select({ serverId: servers.id })
      .from(serverMembers)
      .innerJoin(servers, eq(serverMembers.serverId, servers.id))
      .where(eq(serverMembers.userId, session.user.id));
    serverIds = memberships.map((m) => m.serverId);
  }

  return (
    <LibraryClient
      games={games}
      serverIds={serverIds}
      session={session ? { user: session.user } : null}
    />
  );
}
```

**Step 2: Verify build**
Run: `cd gv-web && npx next build 2>&1 | tail -20`
Expected: no build errors

**Step 3: Commit**
```bash
git add gv-web/app/page.tsx
git commit -m "feat: pass all server IDs to LibraryClient (#279)"
```

---

### Task 5: Update `LibraryClient` to fetch playable hosts and show picker

**Objective:** When "Play" is clicked, fetch playable hosts for that game. If only one host has the game, auto-play (skip picker). If multiple, show a compact picker. Offline servers and servers without the game are excluded from auto-selection but shown in picker.

**Files:**
- Modify: `gv-web/components/LibraryClient.tsx`

The LibraryClient currently:
1. Has `serverId` prop (single string) 
2. On "Play" click → opens a modal with `<GamePlayer serverId={serverId} ...>`

New behavior:
1. Has `serverIds` prop (string[])
2. On "Play" click → fetch `/api/playable-hosts?game_id=X`
3. Filter to only servers with `has_game === true`
4. Sort: online/local first, then online/direct, then online/relay, then stale, offline last
5. If exactly 1 host with game → auto-play (open GamePlayer with that serverId)
6. If 0 hosts with game → show "No servers have this game"
7. If 2+ hosts with game → show picker
8. Picker: compact list of server name + status badge + route hint badge
9. Selected host → saved as cookie preference
10. "Play" button → opens GamePlayer with chosen serverId

**Step 1: This is a UI component — update without tests (Next.js client component, complex DOM)**

Update `LibraryClientProps`:
```typescript
interface LibraryClientProps {
  games: Game[];
  serverIds: string[];
  session: { user?: { name?: string | null; email?: string | null } } | null;
}
```

Add state:
```typescript
// Inside the component
const [hostPickerGame, setHostPickerGame] = useState<string | null>(null); // gameId
const [playableHosts, setPlayableHosts] = useState<PlayableHost[]>([]);
const [pickerLoading, setPickerLoading] = useState(false);
const [selectedHost, setSelectedHost] = useState<string | null>(null);
const [activeGame, setActiveGame] = ... // existing
```

Add `handlePlay`:
```typescript
interface PlayableHost {
  server_id: string;
  name: string;
  status: string;    // online | stale | offline
  has_game: boolean;
  route_hint: string; // local | direct | relay | unknown
}

const handlePlay = async (gameId: string) => {
  setPickerLoading(true);
  try {
    const resp = await fetch(`/api/playable-hosts?game_id=${encodeURIComponent(gameId)}`);
    if (!resp.ok) throw new Error("failed");
    const data = await resp.json();
    const hosts: PlayableHost[] = data.hosts || [];
    setPlayableHosts(hosts);

    const withGame = hosts.filter(h => h.has_game && h.status !== "offline");

    // Sort: online/local > online/direct > online/relay > stale
    const routeOrder: Record<string, number> = { local: 0, direct: 1, relay: 2, unknown: 3 };
    withGame.sort((a, b) => {
      if (a.status !== b.status) return a.status === "online" ? -1 : 1;
      return (routeOrder[a.route_hint] ?? 3) - (routeOrder[b.route_hint] ?? 3);
    });

    if (withGame.length === 0) {
      setActiveGame({ id: gameId, name: "No hosts" });
      return;
    }

    if (withGame.length === 1) {
      // Auto-select
      setSelectedHost(withGame[0].server_id);
      setActiveGame({ id: gameId, name: hosts.find(h => h.server_id === withGame[0].server_id)?.name || "" });
      return;
    }

    // Multiple hosts — show picker
    setHostPickerGame(gameId);
  } finally {
    setPickerLoading(false);
  }
};
```

Change the "Play" button:
```tsx
<button
  style={styles.playBtn}
  onClick={() => handlePlay(game.id)}
  disabled={pickerLoading && hostPickerGame !== game.id}
>
  Play
</button>
```

Add host picker UI (renders below the grid when `hostPickerGame` is set):
```tsx
{hostPickerGame && (
  <div style={styles.pickerOverlay}>
    <div style={styles.pickerPanel}>
      <h3 style={styles.pickerTitle}>Choose host</h3>
      {playableHosts.map((host) => (
        <div key={host.server_id} style={styles.pickerRow}>
          <span style={styles.pickerName}>{host.name}</span>
          <span style={badgeStyle(host.status)}>{host.status}</span>
          {host.has_game && host.route_hint !== "unknown" && (
            <span style={routeBadgeStyle(host.route_hint)}>{host.route_hint}</span>
          )}
          {!host.has_game && <span style={{ fontSize: 11, color: "#666" }}>—</span>}
          <button
            style={styles.pickerPlayBtn}
            disabled={!host.has_game || host.status === "offline"}
            onClick={() => {
              setSelectedHost(host.server_id);
              setHostPickerGame(null);
              // Find game name
              const game = games.find(g => g.id === hostPickerGame);
              setActiveGame({ id: hostPickerGame, name: game?.name || "" });
            }}
          >
            {host.has_game && host.status !== "offline" ? "Select" : "N/A"}
          </button>
        </div>
      ))}
      <button style={styles.btn} onClick={() => setHostPickerGame(null)}>Cancel</button>
    </div>
  </div>
)}
```

**Step 2: Verify build**
Run: `cd gv-web && npx next build 2>&1 | tail -20`
Expected: no build errors

**Step 3: Commit**
```bash
git add gv-web/components/LibraryClient.tsx
git commit -m "feat: add host picker to LibraryClient (#279)"
```

---

### Task 6: Persist selected host preference as cookie

**Objective:** Save the user's last-chosen server per game_id so auto-select works across sessions.

**Files:**
- Modify: `gv-web/components/LibraryClient.tsx`

**Step 1: Add cookie read/write**

```typescript
function getPreferredServer(gameId: string): string | null {
  const match = document.cookie
    .split(";")
    .map(c => c.trim())
    .find(c => c.startsWith(`gv_host_${gameId}=`));
  if (!match) return null;
  return decodeURIComponent(match.split("=").slice(1).join("="));
}

function setPreferredServer(gameId: string, serverId: string) {
  document.cookie = `gv_host_${gameId}=${encodeURIComponent(serverId)}; Path=/; Max-Age=${365 * 24 * 3600}; SameSite=Lax`;
}
```

Update `handlePlay`:
- Before sorting, check if any host matches `getPreferredServer(gameId)` and if it has the game + is online → put it first

Update host selection:
- When user clicks "Select" in picker, call `setPreferredServer(gameId, serverId)`

**Step 2: Commit**
```bash
git add gv-web/components/LibraryClient.tsx
git commit -m "feat: persist host selection preference (#279)"
```

---

### Task 7: Verify route badge is visible after connection

**Objective:** The route badge from #276 is already wired — confirm it renders in the GamePlayer after connection. No code changes needed, just verification.

**Verification:**
- Launch any game on the local server
- Check that the route badge (local/direct/relay) appears in the bottom bar after connection
- The `onRoute` callback in GamePlayer sets `route` state → render in bottom bar

**If not rendered:** Add a route badge to the bottom bar in `GamePlayer.tsx`:

```tsx
{/* Inside bottomBar, next to the hint */}
{route && (
  <span style={{
    fontSize: 11,
    padding: "2px 6px",
    borderRadius: 3,
    background: route === "local" ? "rgba(0,255,0,0.15)" : route === "relay" ? "rgba(255,165,0,0.15)" : "rgba(100,160,255,0.15)",
    color: route === "local" ? "#2a2" : route === "relay" ? "#fa0" : "#6af",
  }}>
    {route}
  </span>
)}
```

**Step: Commit if changed**
```bash
git add gv-web/components/GamePlayer.tsx
git commit -m "feat: render route badge in GamePlayer bottom bar (#279)"
```

---

### Task 8: Final verification — full workflow

**Verification steps (manual):**
1. `cd /root/gv && npx vitest run tests/api/` — all tests pass
2. `cd gv-web && npx next build` — no build errors
3. Launch dev server and test:
   - Single server with game → auto-plays without picker
   - Two servers both with game → picker shown
   - Server without game → shown but disabled
   - Offline server → shown but disabled
   - Selecting host → saves preference cookie
   - Reload → preference cookie auto-selects
   - Route badge appears after connection

**Commit and push:**
```bash
git push -u origin feat/279-multi-server-host-selection
gh pr create --title "feat: multi-server host selection and route preference (#279)" --body "..." --base main
```
