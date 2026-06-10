# Admin Uploader, Home Quick-Resume, Arcade Cleanup & Public Play — Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Four UX cleanups: move game uploader to the nav bar for admins, redesign logged-in home around quick-resume, strip arcade meta counts and make "Choose game" admin-only, enable public arcade play without an account.

**Architecture:** Four independent slices. Each touches 2-4 files. No new controllers or models needed — all changes are markup/pruning plus one seat-assignment policy tweak in `GamePlayRoomService`.

**Tech Stack:** ASP.NET Core MVC, Razor views, existing `CurrentAccessService` / `GamePlayRoomService`.

---

## Current state

- Nav bar (`Views/Shared/_Layout.cshtml:28-52`) shows Home, Arcade, Games (signed-in only), Admin (admin only). No uploader shortcut.
- Logged-in home (`Views/Home/Index.cshtml:127-299`) shows a hero with "Welcome back" + stat tiles (Access, Active machines, Library, Profiles online) + featured session + active machines strip.
- `HomeIndexViewModel` carries `GamesCount`, `SystemsCount`, `TotalPlayTime`, `PlaySessionCount`, `LastPlayedGame`, `ActiveProfiles`, `RecentSessions`, `LibraryPreviewGames` — many unused or clutter-only.
- Arcade page (`Views/Arcade/Index.cshtml:13-17`) shows meta chips: `@Model.CabinetCount cabinet(s)`, `@Model.RunningCabinetCount running`, `@Model.SystemCount system(s)`.
- Arcade `Choose game` modal is already gated behind `@if (Model.CanManage)` (line 44-57), but the meta chips are always visible.
- Public arcade play: `JoinArcadeCabinetAsync` passes `allowPlayerOverride: null` (line 271), which defaults to `CanPlayRoomAsync` — returns false for anonymous users. Free-play cabinets should bypass this.
- `ArcadeCabinet.CreditMode` is `ArcadeCabinetCreditMode.FreePlay` by default on creation.

---

## Task 1: Move game uploader to nav bar for admins

**Objective:** Add an "Add game" nav link visible only to admins, linking to the existing add-game flow.

**Files:**
- Modify: `Views/Shared/_Layout.cshtml`

**Step 1: Add nav item**

In `_Layout.cshtml`, inside the `@if (canManageLibrary)` block (after the Admin link), add:

```html
<li class="nav-item">
    <a class="nav-link text-dark" asp-area="" asp-controller="Games" asp-action="Index" asp-route-openAdd="true">Add game</a>
</li>
```

The existing Games/Index page already supports `?openAdd=true` to auto-open the add-game modal.

**Step 2: Verify**

Run: `dotnet build`
Expected: 0 errors.

Visit `/` as admin — nav bar should show Home | Arcade | Games | Admin | Add game.

**Step 3: Commit**

```bash
git add Views/Shared/_Layout.cshtml
git commit -m "feat: add game uploader shortcut to admin nav bar"
```

---

## Task 2: Redesign logged-in home around quick-resume

**Objective:** Replace the stat-tile hero with a quick-resume strip showing recently played games, keep the active machines strip, drop dead ViewModel data.

**Files:**
- Modify: `Views/Home/Index.cshtml`
- Modify: `Models/ViewModels/HomeIndexViewModel.cs`
- Modify: `Controllers/HomeController.cs`

### Task 2a: Prune dead ViewModel properties

Remove from `HomeIndexViewModel.cs`:
- `GamesCount`
- `SystemsCount`
- `TotalPlayTime`
- `PlaySessionCount`
- `LastPlayedGame`
- `ActiveProfiles`
- `LibraryPreviewGames`
- `TopPlayedGames`
- `GlobalTotalPlayTime`
- `GlobalPlaySessionCount`

Keep: `CurrentProfileId`, `CurrentProfileName`, `AccessMode`, `CanPlay`, `CanManageLibrary`, `FeaturedSession`, `ActiveNosebleedSessions`, `ActiveArcadeCabinets`, `ActiveLibrarySessions`, `RecentSessions`, `ShowDashboard`.

Also remove associated sub-types if unused elsewhere:
- `ActiveProfileSummaryViewModel` (line 126-137)
- `HomeLibraryPreviewGameViewModel` (line 154-162)
- `TopPlayedGameViewModel` (line 35-41)

### Task 2b: Prune dead controller queries

In `HomeController.Index`, remove:
- `gamesCount` / `systemsCount` queries (lines 30-31)
- `telemetryStats` / `globalTelemetryStats` queries (lines 44-47)
- `lastPlayedGame` query (lines 48-57)
- `activeProfileSessionById` computation (lines 80-86)

Continue reading from line 87 to find and keep anything that populates `RecentSessions` or `FeaturedSession`.

### Task 2c: Rewrite logged-in home markup

Replace the hero stat tiles (lines 127-240) with:

```html
@if (Model.CurrentProfileId is not null && Model.ShowDashboard)
{
    @* ── Quick resume ── *@
    @if (Model.RecentSessions.Count > 0)
    {
        <section class="mb-4">
            <h2 class="h5 mb-3">Continue playing</h2>
            <div class="d-flex gap-2 flex-wrap">
                @foreach (var session in Model.RecentSessions.Take(6))
                {
                    <a class="btn btn-outline-secondary" asp-controller="Games" asp-action="PlayServer" asp-route-id="@session.GameId">
                        @session.GameName
                    </a>
                }
            </div>
        </section>
    }

    @* ── Active machines ── *@
    @if (Model.ActiveNosebleedSessions.Count > 0)
    {
        <section class="mb-4">
            <div class="d-flex justify-content-between align-items-end gap-3 flex-wrap mb-3">
                <h2 class="h5 mb-0">Active machines</h2>
                <a class="btn btn-sm btn-outline-secondary" asp-controller="Arcade" asp-action="Index">Open arcade</a>
            </div>
            <div class="row g-3">
                @foreach (var session in Model.ActiveNosebleedSessions.Take(3))
                {
                    <div class="col-md-4">
                        <div class="card h-100 border-0 shadow-sm"
                             data-nosebleed-preview-card
                             data-preview-url="@Url.Action("NosebleedPreviewVideo", "Home", new { sessionId = session.SessionId })"
                             data-stream-url="@Url.Action("NosebleedPreviewStream", "Home", new { sessionId = session.SessionId })">
                            <div class="ratio ratio-16x9 bg-dark rounded-top overflow-hidden">
                                <canvas data-nosebleed-preview-canvas class="w-100 h-100" style="image-rendering: pixelated;"></canvas>
                            </div>
                            <div class="card-body d-flex flex-column">
                                <h3 class="h6 mb-1">@(session.ArcadeCabinetName ?? session.GameName)</h3>
                                <div class="small text-muted mb-2">@(session.IsArcadeCabinet ? "Arcade" : "Library") · @FormatDuration(session.Runtime)</div>
                                <div class="mt-auto">
                                    @if (session.IsArcadeCabinet && session.ArcadeCabinetId is not null)
                                    {
                                        <a class="btn btn-sm btn-primary" href="@Url.RouteUrl("ArcadeSession", new { sessionId = session.SessionId })">Play</a>
                                    }
                                    else if (!string.IsNullOrWhiteSpace(session.RoomCode))
                                    {
                                        <a class="btn btn-sm btn-primary" asp-controller="Games" asp-action="PlayServer" asp-route-id="@session.GameId" asp-route-code="@session.RoomCode">Play</a>
                                    }
                                </div>
                            </div>
                        </div>
                    </div>
                }
            </div>
        </section>
    }

    @if (Model.ActiveNosebleedSessions.Count == 0)
    {
        <div class="text-center py-5">
            <p class="text-muted mb-3">No active machines right now.</p>
            <a class="btn btn-primary" asp-controller="Games" asp-action="Index">Browse games</a>
        </div>
    }
}
```

Keep the existing `@section Scripts` for preview.js.

### Task 2d: Build and test

```bash
dotnet build
dotnet test
```

Expected: 0 errors, all tests pass. Update any tests referencing removed ViewModel properties.

### Task 2e: Commit

```bash
git add Controllers/HomeController.cs Models/ViewModels/HomeIndexViewModel.cs Views/Home/Index.cshtml tests/
git commit -m "feat: redesign logged-in home around quick-resume"
```

---

## Task 3: Strip arcade meta counts, keep "Choose game" admin-only

**Objective:** Remove `CabinetCount`, `RunningCabinetCount`, `SystemCount` from the arcade page header. "Choose game" already admin-only — just clean up the dead view-model properties.

**Files:**
- Modify: `Views/Arcade/Index.cshtml`
- Modify: `Controllers/ArcadeController.cs`

### Task 3a: Remove meta chips from view

Remove lines 13-17 of `Views/Arcade/Index.cshtml`:
```html
<div class="d-flex flex-wrap gap-2 small text-muted">
    <span class="games-meta-chip">@Model.CabinetCount cabinet@(Model.CabinetCount == 1 ? "" : "s")</span>
    <span class="games-meta-chip">@Model.RunningCabinetCount running</span>
    <span class="games-meta-chip">@Model.SystemCount system@(Model.SystemCount == 1 ? "" : "s")</span>
</div>
```

### Task 3b: Remove dead properties from controller

In `ArcadeController.Index` (line 81-83), remove:
```csharp
CabinetCount = cabinets.Count,
RunningCabinetCount = cabinets.Count(x => x.IsRunning),
SystemCount = cabinets.Select(...).Distinct(...).Count(),
```

### Task 3c: Remove dead properties from ViewModel

Find and remove `CabinetCount`, `RunningCabinetCount`, `SystemCount` from `ArcadeIndexViewModel`.

### Task 3d: Build and test

```bash
dotnet build
dotnet test
```

### Task 3e: Commit

```bash
git add Views/Arcade/Index.cshtml Controllers/ArcadeController.cs Models/ViewModels/ArcadeIndexViewModel.cs
git commit -m "feat: strip arcade meta counts, keep choose-game admin-only"
```

---

## Task 4: Enable public arcade play without an account

**Objective:** On free-play arcade cabinets, let anonymous viewers join as players (not just spectators). Keep library sessions gated.

**Files:**
- Modify: `Gameplay/GamePlayRoomService.cs`
- Modify: `Views/Arcade/Index.cshtml` (button labels)
- Modify: `Controllers/ArcadeController.cs` (BuildCabinetSessionViewAsync already sets `IsSpectator` based on seat kind — should work automatically)

### Task 4a: Override player access for free-play cabinets

In `GamePlayRoomService.JoinArcadeCabinetAsync`, change line 271 from:
```csharp
return await JoinRoomAsync(room, viewerId, ct, allowPlayerOverride: null);
```
to:
```csharp
var isFreePlay = cabinet.CreditMode == ArcadeCabinetCreditMode.FreePlay;
return await JoinRoomAsync(room, viewerId, ct, allowPlayerOverride: isFreePlay ? true : null);
```

This means: on free-play cabinets, `allowPlayerOverride = true` → the seat assignment grants a player seat even to anonymous users. On token-gated cabinets, `null` → falls through to normal `CanPlayRoomAsync` check.

### Task 4b: Update arcade card button labels

In `Views/Arcade/Index.cshtml`, the cabinet card buttons currently show `@(Model.CanPlay ? "Join" : "Watch")`. Since free-play cabinets now allow anyone to play, change to always show "Play":

```html
<a class="btn btn-sm btn-primary" ...>Play</a>
```

(Line 111 and 115 — two occurrences: one for running cabinets with `ArcadeSession` route, one for non-running with `Join` action.)

### Task 4c: Verify

- Build and test: `dotnet build && dotnet test`
- Manual verification: as anonymous user, visit an arcade cabinet → should get a player seat (not spectator) in the PlayServer view

### Task 4d: Commit

```bash
git add Gameplay/GamePlayRoomService.cs Views/Arcade/Index.cshtml
git commit -m "feat: enable public play on free-play arcade cabinets"
```

---

## Verification sweep

After all tasks:

```bash
dotnet build
dotnet test
```

Expected: 0 build errors, all tests pass.

Manual checks:
- Admin sees "Add game" in nav bar, clicking it opens Games page with add modal open
- Logged-in home shows "Continue playing" strip + active machines previews, no stat tiles
- Arcade page has no meta chips in header, "Choose game" button only for admins
- Anonymous user can play a free-play arcade cabinet (gets player seat, not spectator)
