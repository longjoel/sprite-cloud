# Games Page UX Refresh Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Make the Games experience feel like a product surface instead of an admin table by improving browse/play flow first, then making add/import visible and easier to use, then finishing the dashboard polish.

**Architecture:** Keep the existing ASP.NET Core MVC + Razor data flow, but reshape the Games UI into product-facing browse and add/import surfaces. Reuse the existing search, batch, upload/import, and play endpoints rather than inventing new backend flows. Start with a low-risk UI-first slice in `Views/Games/*`, then add dashboard data slices in `HomeController` / `HomeIndexViewModel` once the Games surface is cleaner.

**Tech Stack:** ASP.NET Core MVC, Razor partials, Bootstrap, existing Games/Nosebleed controllers, xUnit.

---

## Current State Captured

- Repo: `/root/projects/games-vault`
- Branch: `main`
- Worktree already contains unrelated in-progress auth changes in profile files; avoid touching those files in this UX slice.
- `Views/Games/Index.cshtml` already has:
  - search box + live-search/AJAX bank refresh
  - modal-based add/import surface
  - batch side column
- `Views/Games/_AddGameModalBody.cshtml` already has the add/import tabs (`Upload`, `Import From Web`, `Import From Share`, `Import From Filesystem`). The problem is visibility and context switching, not missing tabs.
- `Views/Games/_GamesBank.cshtml` is still table-first and admin-heavy.
- `GamesController.PlayServer(int id)` already exists and is the right one-click play target.
- Home already shows active Nosebleed sessions and telemetry cards, but does not yet explicitly show active profiles or a recent sessions feed.

## Product Direction for This Track

### Track A — Games browse + launch
- Search should stay prominent.
- Browse should feel like a library, not a CRUD table.
- Server-side play should be the primary action.
- Batch operations should survive, but as a secondary workflow rather than the visual center of the page.

### Track B — Add / import games
- The existing tabbed add/import flow should be visible directly on the Games page.
- Do not hide core import actions behind a modal by default.
- Returning scan sessions (`webSessionId`, `localSessionId`, etc.) should still land the user in the add/import surface.

### Track C — Home/dashboard follow-up
- Add active profiles.
- Add recent sessions.
- Distinguish arcade activity more clearly from generic active sessions.

---

## Phase 1: First shipped UX slice

### Task 1: Turn the Games page into two visible surfaces
**Objective:** Replace the modal-first experience with page-level Browse and Add/Import tabs.

**Files:**
- Modify: `Views/Games/Index.cshtml`
- Reuse: `Views/Games/_AddGameModalBody.cshtml`

**Implementation notes:**
- Remove the modal wrapper from the main Games index experience.
- Add page-level nav tabs:
  - `Browse library`
  - `Add / import games`
- Use the existing `OpenAddGameModal` flag as the server-side selector for the active Add/Import tab so current redirects still land in the correct surface.
- Render `_AddGameModalBody` inline inside a card/panel with a short explanatory intro.
- Replace the top-right `Add game` button with a tab/action that switches to the visible Add/Import surface.

**Verification:**
- `/Games` defaults to Browse.
- `/Games?openAdd=true` opens Add/Import.
- Existing add/import scan continuation querystrings still render the add/import surface.

### Task 2: Replace the table-first bank with card-first browse
**Objective:** Make the browse experience feel like a game library with clearer primary actions.

**Files:**
- Modify: `Views/Games/_GamesBank.cshtml`
- Keep compatible with: `Views/Games/Index.cshtml` AJAX refresh JS

**Implementation notes:**
- Preserve bulk selection + batch actions.
- Replace the table body with a responsive card grid.
- Each card should show:
  - game name
  - system
  - file count
  - missing-system-file warning when applicable
  - primary `Play server-side` button
  - secondary browse/details/actions affordances
- Keep inline details/edit collapses available, but tuck them beneath the card instead of centering the entire layout around a table row.
- Keep pagination and AJAX bank replacement working unchanged.

**Verification:**
- Live search still refreshes the bank.
- Bulk select still works.
- Pagination still works.
- Play server-side is visible without opening a dropdown.

### Task 3: Tighten page copy and visual hierarchy
**Objective:** Make the page explain itself and reduce admin-tool energy.

**Files:**
- Modify: `Views/Games/Index.cshtml`
- Modify: `Views/Games/_GamesBank.cshtml`

**Implementation notes:**
- Add a short subtitle under `Games` explaining browse/play/import.
- Make batch tools read as a secondary workspace.
- Make empty states actionable (`Search again`, `Switch to Add / import`, etc.).

**Verification:**
- A new user can infer how to browse, launch, and add games without discovering a modal.

---

## Phase 2: Home/dashboard follow-up

### Task 4: Add recent sessions feed to home
**Status:** Implemented on 2026-05-31

**Files:**
- Modify: `Controllers/HomeController.cs`
- Modify: `Models/ViewModels/HomeIndexViewModel.cs`
- Modify: `Views/Home/Index.cshtml`

**Shipped notes:**
- Added a recent sessions activity feed to the dashboard.
- Feed is profile-scoped when a current profile is selected, otherwise it shows library-wide activity.
- Recent rows surface game, mode, player, duration, and whether the session is still active.

### Task 5: Add active profiles section to home
**Status:** Implemented on 2026-05-31

**Files:**
- Modify: `Controllers/HomeController.cs`
- Modify: `Models/ViewModels/HomeIndexViewModel.cs`
- Modify: `Views/Home/Index.cshtml`

**Shipped notes:**
- Added an Active profiles card driven by non-revoked profile auth sessions.
- Active profiles surface display name, username, admin/current-profile badges, last-seen time, and current game when applicable.

### Task 6: Distinguish arcade activity from generic active sessions
**Status:** Implemented on 2026-05-31

**Files:**
- Modify: `Controllers/HomeController.cs`
- Modify: `Models/ViewModels/HomeIndexViewModel.cs`
- Modify: `Views/Home/Index.cshtml`

**Shipped notes:**
- Dashboard active sessions are now classified as either arcade cabinet activity or ad-hoc library sessions.
- Added separate Arcade activity and Library sessions cards on Home.
- Session cards and the session manager now label arcade vs library runs explicitly and route arcade launches to `/Arcade/Join`.

---

## Notes / Non-Goals

- Do not remove batch/export workflows in this track.
- Do not rework authentication here.
- Do not start with a large backend rewrite; prioritize UI-first improvements using the existing controller actions.
- If card browse later needs metadata/artwork, add that in a follow-up rather than blocking this slice.

---

## Suggested next commit sequence
1. `feat(games-ui): make add/import visible on the Games page`
2. `feat(games-ui): switch browse bank from table-first to card-first`
3. `feat(home): add recent sessions and active profiles`
