# Dashboard Consolidation Implementation Plan

> **For Hermes:** Execute task-by-task. Commit after each task.

**Goal:** One operator page (`/dashboard`) that has everything. Kill `/dev` and `/settings` (redirect both to `/dashboard`).

**Architecture:** `/dashboard` stays server-rendered (fetches data server-side) but embeds client islands for interactive sections. The page pulls in server list + management from settings, dev tools from `/dev`, and keeps its own sessions/commands/library sections.

**Tech Stack:** Next.js 15, React 19, Drizzle ORM, Humidor design tokens, inline CSS

---

## Current state (3 pages)

| Page | Section | Where it lives |
|------|---------|----------------|
| `/dashboard` | Server status card | page.tsx (server) |
| `/dashboard` | Sessions (counts + active) | page.tsx (server) |
| `/dashboard` | Commands (last 20) | page.tsx (server) |
| `/dashboard` | Library stats | page.tsx (server) |
| `/dashboard` | Live versions table | page.tsx (server) |
| `/settings` | Server list + status badges | SettingsClient.tsx (client) |
| `/settings` | Server expand panels (ROM browse/scan/connectivity/components) | SettingsClient.tsx → ServerPanel.tsx (client) |
| `/settings` | Rename server | SettingsClient.tsx (client) |
| `/settings` | Delete server | SettingsClient.tsx (client) |
| `/settings` | Pairing code generator | SettingsClient.tsx (client) |
| `/dev` | Health cards (gv-web, DB, poll API) | page.tsx (client, 5s auto-refresh) |
| `/dev` | Live version cards | page.tsx (client, from /api/health) |
| `/dev` | Pairing code | page.tsx (client) |
| `/dev` | Command queue tester | page.tsx (client) |
| `/dev` | Play Game tester | page.tsx (client) |
| `/dev` | Links row | page.tsx (client) |

## Target state (1 page)

`/dashboard`:
1. **Health & Status** — health cards (from dev) + server online/offline (from dashboard)
2. **Servers** — server list with status badges, rename, delete, expand panels with ROM browse/scan/connectivity/components (from settings)
3. **Pairing** — pairing code generator (from settings, remove from dev)
4. **Sessions & Commands** — existing dashboard sections (keep)
5. **Library** — existing library stats (keep)
6. **Live Versions** — existing versions table (keep, remove cards from dev)
7. **Dev Tools** — command queue + play game (from dev, collapsed behind a toggle)
8. **Links** — external links row (from dev)

`/settings` → redirect to `/dashboard`
`/dev` → redirect to `/dashboard`

---

## Security model

| Threat | Mitigation | Where |
|--------|-----------|-------|
| Unauthenticated access | `auth()` gate + redirect to signin | Task 2 (page.tsx) |
| Non-admin rename/delete | Server-side role check in API routes | Already done (PATCH/DELETE routes) |
| CSRF on mutations | `csrfHeaders()` on all POST/PATCH/DELETE | SettingsClient.tsx (already) |
| Dev tools exposed to non-admins | Admin-only gate on dev tools section | Task 6 |

---

## Task 1: Move health cards + live versions into dashboard server component

**Objective:** Dashboard now fetches health data server-side and renders health cards + version table as its first sections.

**Files:**
- Modify: `gv-web/app/dashboard/page.tsx`

**Step 1: Add health data fetch to the page**

In the server component, add a fetch to `/api/health` (or replicate the DB queries inline — simpler: just read `servers` table directly since we already query it).

The health cards need: DB status (always ok if we're rendering), gv-server status (from lastSeenAt), and any component health. Since this is a server component, we can compute these directly from the data we already fetch.

We already fetch `adminServers` with `lastSeenAt` — so "gv-web" = always up (we're serving the page), "DB" = connected (drizzle queries work), "gv-server" = online if lastSeenAt < 120s.

**Step 2: Rendering**

Add a health cards row at the top of the dashboard render, BEFORE the existing "Live versions" section. Move Live versions to right after health.

```tsx
{/* ── Health ─────────────────────────────────────────────── */}
<section style={S.section}>
  <h2 style={S.h2}>Health</h2>
  <div style={S.card}>
    <div style={S.healthRow}>
      <HealthCard label="gv-web" value="up" ok={true} />
      <HealthCard label="DB" value="connected" ok={true} />
      <HealthCard
        label="gv-server"
        value={serverOnline ? "online" : "offline"}
        ok={serverOnline}
      />
      <HealthCard
        label="last poll"
        value={lastSeenSecs !== null ? `${lastSeenSecs}s ago` : "—"}
        ok={lastSeenSecs !== null && lastSeenSecs < 300}
      />
    </div>
  </div>
</section>
```

**Step 3: Add HealthCard component**

```tsx
function HealthCard({ label, value, ok }: { label: string; value: string; ok: boolean }) {
  return (
    <div style={{
      ...S.healthCard,
      borderColor: ok ? "var(--color-success)" : "var(--color-error)",
    }}>
      <div style={S.healthLabel}>{label}</div>
      <div style={S.healthValue}>{value}</div>
    </div>
  );
}
```

Add styles:
```tsx
healthRow: { display: "flex", gap: "var(--space-5)", flexWrap: "wrap" as const },
healthCard: {
  border: "1px solid var(--color-bamboo)",
  padding: "var(--space-4) var(--space-6)",
  borderRadius: "var(--radius-md)",
  minWidth: 120,
  background: "var(--color-teak)",
},
healthLabel: {
  fontSize: "var(--font-size-xs)",
  color: "var(--color-muted)",
  marginBottom: "var(--space-2)",
  fontFamily: "var(--font-mono)",
},
healthValue: {
  fontSize: "var(--font-size-lg)",
  color: "var(--color-cream)",
  fontFamily: "var(--font-mono)",
},
```

**Acceptance:**
- Dashboard renders health cards: gv-web (green), DB (green), gv-server (green/red based on lastSeenAt), last poll (time)
- `pnpm build` passes
- Git commit

---

## Task 2: Merge server management into dashboard

**Objective:** The server list with status badges, rename, delete, expand panels, and pairing code moves from `/settings` into `/dashboard`.

**Files:**
- Modify: `gv-web/app/dashboard/page.tsx`
- Reference: `gv-web/app/settings/SettingsClient.tsx` (extract sections from here)
- Reference: `gv-web/app/settings/ServerPanel.tsx` (reuse)
- Delete: `gv-web/app/settings/SettingsClient.tsx` (after extraction)
- Delete: `gv-web/app/settings/ServerPanel.tsx` (after extraction)
- Delete: `gv-web/app/settings/page.tsx` (replaced by redirect)

**IMPORTANT — don't delete yet, just extract and add to dashboard. Deletion happens in Task 4.**

**Step 1: Create DashboardClient.tsx**

Extract the interactive server list from SettingsClient into a new `app/dashboard/DashboardClient.tsx`. This component takes memberships as props (fetched server-side) and renders:

- Server list table with status dots, name (editable), last seen, role, actions (Manage/Remove)
- Expand panels with ServerPanel inside
- Rename (inline edit → PATCH)
- Delete (confirm dialog → DELETE)
- Pairing code generator

Move ServerPanel.tsx to the dashboard directory:
```bash
mv gv-web/app/settings/ServerPanel.tsx gv-web/app/dashboard/ServerPanel.tsx
```

Update the import in DashboardClient:
```tsx
import ServerPanel from "./ServerPanel";
```

Remove the SettingsClient.tsx wrapper — DashboardClient IS the component.

**Step 2: Wire into dashboard page.tsx**

In `page.tsx`, import and render DashboardClient at the right position (after health/versions, before sessions):

```tsx
import DashboardClient from "./DashboardClient";

// ... in the return:
<DashboardClient memberships={adminServers.map(srv => ({
  id: srv.id,
  name: srv.name || srv.id.slice(0, 8),
  lastSeenAt: srv.lastSeenAt?.toISOString() ?? null,
  role: "admin", // dashboard is admin-only, all servers here are admin'd
  romRoots: romRootsByServer[srv.id] ?? [],
}))} />
```

Need to fetch ROM roots per server (like settings page currently does). Add the ROM roots query from settings/page.tsx.

**Step 3: Remove redundant server status section**

The current dashboard has a "Server Status" section (lines ~220-280). This is now redundant — the server list in DashboardClient handles status. Remove the old Server Status section. Keep the `serverOnline` and `lastSeenSecs` variables for the health cards.

**Acceptance:**
- Dashboard shows server list with status dots, rename, delete, expand
- "Manage" expands to show ROM browse/scan/connectivity/components
- Pairing code generator works
- `pnpm build` passes
- Git commit

---

## Task 3: Add dev tools section (collapsed by default)

**Objective:** Command queue tester and play-game tester from `/dev` move into `/dashboard` behind a collapsible toggle.

**Files:**
- Modify: `gv-web/app/dashboard/DashboardClient.tsx`

**Step 1: Add dev tools state**

At the top of DashboardClient:
```tsx
const [showDevTools, setShowDevTools] = useState(false);
```

**Step 2: Extract dev tools from dev/page.tsx**

Copy the command queue and play game sections from `gv-web/app/dev/page.tsx` (lines ~230-325 in original, the form + play sections). Strip out the surrounding page chrome — just the forms.

Paste into DashboardClient, wrapped in:
```tsx
{showDevTools && (
  <section style={S.section}>
    <h2 style={S.h2}>Dev tools</h2>
    {/* Command queue form */}
    {/* Play Game form */}
  </section>
)}
```

Add a toggle button somewhere (e.g., in the header or after the links):
```tsx
<Button variant="ghost" size="sm" onClick={() => setShowDevTools(!showDevTools)}>
  {showDevTools ? "Hide dev tools" : "Dev tools"}
</Button>
```

**Step 3: Copy any needed state/helpers**

Copy `NUMERIC_UUID_RE`, `csrfHeaders`, `cmdServerId`, `cmdType`, `cmdPayload`, `cmdResult`, `queueCommand`, `playServerId`, `playGameId`, `playStatus`, `workerUrl`, `playGame` from dev/page.tsx.

**Acceptance:**
- "Dev tools" button visible on dashboard
- Clicking expands command queue + play game forms
- Can queue a command and see result
- Can play a game and get worker URL link
- `pnpm build` passes
- Git commit

---

## Task 4: Add links + cleanup dead pages

**Objective:** Links row from dev moves to dashboard. `/settings` and `/dev` redirect to `/dashboard`.

**Files:**
- Modify: `gv-web/app/dashboard/DashboardClient.tsx` (add links)
- Modify: `gv-web/app/settings/page.tsx` (redirect)
- Modify: `gv-web/app/settings/[server_id]/page.tsx` (already redirects — verify)
- Modify: `gv-web/app/dev/page.tsx` (redirect)
- Delete: `gv-web/app/settings/SettingsClient.tsx`
- Delete: `gv-web/app/dashboard/ServerPanel.tsx` (already moved in Task 2 — verify path)

**Step 1: Add links to dashboard**

At the bottom of the dashboard render (before the closing `</main>`):
```tsx
<p>
  <a href="/" style={S.link}>← Library</a>
  {" · "}
  <a href="http://localhost:8096" style={S.link}>Jellyfin</a>
  {" · "}
  <a href="http://localhost:8123" style={S.link}>Home Assistant</a>
</p>
```

**Step 2: Redirect /settings**

```tsx
// gv-web/app/settings/page.tsx
import { redirect } from "next/navigation";
export default function SettingsPage() {
  redirect("/dashboard");
}
```

Also handle `/settings/[server_id]` — it already redirects to `/settings` which becomes `/dashboard`. That's fine, the chain works.

**Step 3: Redirect /dev**

```tsx
// gv-web/app/dev/page.tsx
import { redirect } from "next/navigation";
export default function DevPage() {
  redirect("/dashboard");
}
```

**Step 4: Delete SettingsClient.tsx**

```bash
rm gv-web/app/settings/SettingsClient.tsx
```

**Acceptance:**
- `/settings` → redirects to `/dashboard`
- `/settings/<uuid>` → redirects to `/dashboard`
- `/dev` → redirects to `/dashboard`
- Links visible at bottom of dashboard
- No dead imports
- `pnpm build` passes
- Git commit

---

## Task 5: Ship — build, deploy, smoke test

**Objective:** Build both sides, deploy web + host, verify smoke test passes, confirm dashboard loads.

```bash
# Build web
cd gv-web && pnpm build

# Commit
git add -A
git commit -m "feat: consolidate settings + dev into dashboard

- Dashboard now has: health cards, server list + management, ROM browse/scan,
  connectivity, component versions, pairing code, sessions, commands, library,
  live versions, dev tools (collapsed), and external links.
- /settings and /dev redirect to /dashboard.
- Deleted SettingsClient.tsx.

Closes #XXX"

# Deploy
./scripts/deploy-vps-web.sh

# Smoke test
./scripts/smoke-test.sh

# Verify
curl -s https://lngnckr.tech/dashboard | head -c 200  # should show HTML
curl -s -o /dev/null -w "%{http_code}" https://lngnckr.tech/settings  # should be 200 (redirect renders)
curl -s -o /dev/null -w "%{http_code}" https://lngnckr.tech/dev  # should be 200 (redirect renders)
```

**Acceptance:**
- `pnpm build` passes
- Deploy succeeds
- Smoke test passes
- `/dashboard` loads
- `/settings` redirects to `/dashboard`
- `/dev` redirects to `/dashboard`
