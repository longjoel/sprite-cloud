# Library, Dashboard, and New-User UX Cleanup Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Make the library views consistent, simplify the dashboard around servers, and replace tell-heavy onboarding with a playable/watchable public entry path.

**Architecture:** Keep this as a product cleanup program, not a rewrite. The main theme is to stop rendering the same concepts twice in incompatible ways: unify library actions behind one shared game action model, collapse the dashboard into a server-first operational view, and add a public featured/share surface so the first-time experience demonstrates the product instead of explaining it.

**Tech Stack:** Next.js App Router, React client components, Drizzle-backed APIs already in place, existing Metro/Fluent design system.

---

## Current-state audit

### Library
- `gv-web/components/LibraryClient.tsx:454-463` renders grid items through `GameTile`.
- `gv-web/components/LibraryClient.tsx:466-530` renders table rows through a separate hand-built `<tr>` path.
- `gv-web/components/LibraryClient.tsx:554-590` exposes a grid/table toggle, but the two render paths do not share a common action model.
- `gv-web/components/fluent/GameTile.tsx:15-27` supports play, favorite, and rename, but **not pin**.
- `gv-web/components/LibraryClient.tsx:507-523` shows pin control only in table view.
- Result: grid/table feature parity is structurally impossible without refactoring.

### Dashboard
- `gv-web/app/dashboard/page.tsx:203-235` renders a top “Health” strip with hardcoded-looking status summaries.
- `gv-web/app/dashboard/page.tsx:249-438` renders sessions, commands, and library summary sections below the server list.
- `gv-web/app/dashboard/DashboardClient.tsx:118-215` already contains the most valuable surface: the actual server inventory and server-management controls.
- Result: the dashboard buries the useful server list beneath broad, partly misleading summary panels and non-server-centric noise.

### New-user entry
- `gv-web/app/page.tsx:14-23` sends unauthenticated users to `LandingPage`.
- `gv-web/components/LandingPage.tsx:19-41` is a text-heavy 4-step setup guide.
- `gv-web/components/LandingPage.tsx:83-89` hardcodes demo credentials instead of giving a one-click “watch/try” experience.
- Result: we explain the system, but we do not immediately let a new visitor touch it.

---

## Proposed issue slices

### Slice A — Library: unify grid/table interaction parity
**Files:**
- Modify: `gv-web/components/LibraryClient.tsx`
- Modify: `gv-web/components/fluent/GameTile.tsx`
- Create or extract: `gv-web/components/library/*` as needed
- Test: `gv-web/tests/api/routes.test.ts` if any supporting API shape changes

**What to do:**
1. Introduce a shared game-item action/view model used by both grid and table render paths.
2. Make the same actions available in both modes: play, favorite, pin, rename.
3. Remove view-specific behavior drift so switching view mode does not change what the user can do.

**Acceptance criteria:**
- Grid and table expose the same core actions.
- No action is available in only one view.
- View toggle changes presentation only, not capability.

### Slice B — Library: visual cleanup for grid and table
**Files:**
- Modify: `gv-web/components/LibraryClient.tsx`
- Modify: `gv-web/components/fluent/GameTile.tsx`
- Modify: relevant shared CSS/token usage if needed

**What to do:**
1. Improve the grid so it looks deliberate instead of like a fallback card dump.
2. Improve the table so it matches the Metro/Fluent visual language and reads as a first-class view, not a debug table.
3. Align metadata density, spacing, and action placement between both views.

**Acceptance criteria:**
- Grid and table feel like two polished presentations of the same library.
- Important metadata is visible in both modes.
- Pinned/favorite state is visually obvious in both modes.

### Slice C — Dashboard: remove misleading top-level summary panels
**Files:**
- Modify: `gv-web/app/dashboard/page.tsx`
- Possibly modify: `gv-web/app/dashboard/HealthCard.tsx`

**What to do:**
1. Remove or demote the current top “Health” strip.
2. Remove or move non-server-first summary sections (sessions/commands/library totals) out of the default dashboard path.
3. Make the page answer one question first: “what servers do I have, and what state are they in?”

**Acceptance criteria:**
- The first visible dashboard content is server-centric.
- No obviously misleading hardcoded-feeling status strip remains at the top.
- The dashboard stops feeling tailored to one operator’s personal home setup.

### Slice D — Dashboard: refine server details into the primary admin surface
**Files:**
- Modify: `gv-web/app/dashboard/DashboardClient.tsx`
- Modify: `gv-web/app/dashboard/ServerPanel.tsx`
- Modify: `gv-web/app/dashboard/dashboard-utils.ts` if display helpers need changes

**What to do:**
1. Make each server row carry the important operational details directly.
2. Keep expand/manage flows, but prioritize practical server facts over side/admin/dev clutter.
3. Reduce the gap between the list view and the detailed server panel.

**Acceptance criteria:**
- A server’s useful status/details are readable without hunting through unrelated sections.
- Server management remains available, but the page is less noisy.
- The dashboard can be understood as “servers and server details,” not “misc admin miscellany.”

### Slice E — New-user experience: show, don’t tell
**Files:**
- Modify: `gv-web/components/LandingPage.tsx`
- Modify: `gv-web/app/page.tsx`
- Potentially modify/create: room/share/featured-game supporting API or config surfaces, depending on implementation choice

**What to do:**
1. Replace the hardcoded demo-login callout with a permanent public “watch / try” entry.
2. Keep account creation available, but stop making text instructions the primary first-run experience.
3. Give unauthenticated visitors a direct path into a real game/session/share surface.

**Acceptance criteria:**
- A new visitor can click into a real experience without first creating an account.
- The landing page demonstrates the product instead of only describing setup.
- Demo/public entry does not depend on exposing reusable credentials in the UI.

---

## Recommended rollout order
1. Slice C — simplify dashboard framing first.
2. Slice D — make server details the center of the dashboard.
3. Slice A — fix library capability parity.
4. Slice B — polish the library presentations.
5. Slice E — replace demo-login onboarding with a public playable/watchable path.

---

## Verification expectations
- `pnpm vitest run tests/api/routes.test.ts`
- `pnpm run lint`
- `pnpm run build`
- Manual smoke checks:
  - library grid ↔ table toggle preserves capabilities
  - dashboard first paint is server-centric
  - landing page gives a direct public try/watch action
