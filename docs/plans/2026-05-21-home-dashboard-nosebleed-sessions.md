# Home Dashboard + Nosebleed Session Manager Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Replace the setup-only home screen with a dashboard that appears once the library has enough data, shows play-time/library metrics, highlights active Nosebleed sessions in a jumbotron with live previews, and gives Joel a session manager for killing orphaned Nosebleed instances.

**Architecture:** Add persistent gameplay/session telemetry to the ASP.NET Core app, extend the existing in-memory `NosebleedSessionManager` with safe snapshot/stop operations, then render a dashboard-first `Home/Index` when data exists while keeping setup actions available as an onboarding panel. For live previews, start with a lightweight browser preview card that reuses each session's `BaseUrl` and token/preview endpoint shape without inventing persistent matchmaking.

**Tech Stack:** ASP.NET Core MVC, EF Core SQLite migrations, Bootstrap/Razor views, existing `games_vault.Nosebleed` sidecar orchestration, xUnit tests.

---

## Current State Captured

- Source checkout: `/root/projects/games-vault`.
- Current branch: `feat/nosebleed-sidecar-playback`.
- Home screen is setup-focused:
  - `Controllers/HomeController.cs`
  - `Models/ViewModels/HomeIndexViewModel.cs`
  - `Views/Home/Index.cshtml`
- Existing Home data: games count, source counts, system-file counts, libretro/web-player setup state, latest setup jobs.
- Nosebleed integration already exists:
  - `Nosebleed/NosebleedSessionManager.cs` starts/reuses sidecar processes and stores sessions in a private in-memory dictionary.
  - `GamesController.PlayServer(int id)` starts a server-side session and renders `Views/Games/PlayServer.cshtml`.
  - `GamesController.KeepAliveServerSession` and `LeaveServerSession` manage viewer seats but do not stop the process.
- No persistent gameplay telemetry model exists yet. `Game` and `GameFile` do not track last played or duration.
- Existing tests are minimal and centered on `NosebleedSeatManager`.

## Product Shape for Today

### Dashboard readiness

Show the dashboard when any of these are true:

- At least one game has a recorded play session.
- At least one active Nosebleed session exists.
- Library has at least one imported game and setup basics are complete enough to be useful.

Otherwise keep the current setup/checklist view prominent.

### Dashboard widgets

- Library overview: total games, systems, files, total storage bytes.
- Gameplay overview: total play time, sessions played, last played game, top 5 games by play time.
- Nosebleed jumbotron: active server-side sessions with game title, system, runtime, player/spectator counts, port/base URL, and preview/connect/kill controls.
- Session manager: a compact table of active managed sessions plus discovered orphan candidates.

### Orphan definition for MVP

- Managed active session: known to `NosebleedSessionManager` and process is still running.
- Exited managed session: known but process has exited; remove from manager snapshot on cleanup.
- Orphan candidate: `nosebleed` process on this host that was not started by the current in-memory manager but looks like a games-vault sidecar via command line (`--session-id games-vault-...`, configured binary path, or listen port range). Show it with conservative metadata and a kill button.

---

## Task 1: Add gameplay telemetry models

**Objective:** Persist gameplay sessions so the dashboard has real historical data.

**Files:**
- Create: `Models/GamePlaySession.cs`
- Modify: `Data/AppDbContext.cs`
- Create migration: `Migrations/<timestamp>_AddGamePlaySessions.cs`
- Test: add model/context tests if a test database helper exists; otherwise cover via build and migration generation.

**Implementation notes:**

Create `GamePlaySession` with:

- `Id`
- `GameId`
- `GameFileId?`
- `Game Game`
- `GameFile? GameFile`
- `string Mode` (`browser`, `nosebleed`, future-safe but no enum migration pain)
- `string? ExternalSessionId` for Nosebleed session id
- `DateTime StartedUtc`
- `DateTime? EndedUtc`
- `int DurationSeconds`
- `string? EndReason` (`leave`, `stop`, `process-exit`, `timeout`, `unknown`)

Configure indexes:

- `GameId, StartedUtc`
- `ExternalSessionId`
- `Mode, StartedUtc`

**Verification:**

Run:

```bash
dotnet ef migrations add AddGamePlaySessions
dotnet build games-vault.sln -c Release
```

Expected: migration created and build passes.

---

## Task 2: Create gameplay telemetry service

**Objective:** Centralize start/finish/update logic so controllers and session manager do not duplicate DB mutations.

**Files:**
- Create: `Gameplay/GamePlayTelemetryService.cs`
- Modify: `Program.cs`
- Test: create `tests/games-vault.Tests/GamePlayTelemetryServiceTests.cs` if feasible with in-memory SQLite.

**Service methods:**

- `Task<GamePlaySession> StartAsync(int gameId, int? fileId, string mode, string? externalSessionId, CancellationToken ct)`
- `Task FinishByExternalSessionAsync(string externalSessionId, string endReason, CancellationToken ct)`
- `Task TouchDurationAsync(string externalSessionId, CancellationToken ct)`
- `Task<DashboardGameplayStats> GetDashboardStatsAsync(CancellationToken ct)`

**Rules:**

- `DurationSeconds` should be computed from `StartedUtc` to `EndedUtc` or `DateTime.UtcNow` for active sessions.
- If `StartAsync` sees an active record for the same `ExternalSessionId`, reuse it instead of creating duplicates.

**Verification:**

Run:

```bash
dotnet test tests/games-vault.Tests/games-vault.Tests.csproj
dotnet build games-vault.sln -c Release
```

Expected: tests/build pass.

---

## Task 3: Extend Nosebleed session manager with snapshots and stop

**Objective:** Allow Home/dashboard code to list and stop managed sessions safely.

**Files:**
- Modify: `Nosebleed/NosebleedSession.cs`
- Modify: `Nosebleed/NosebleedSessionManager.cs`
- Create: `Nosebleed/NosebleedSessionSnapshot.cs`
- Test: add `tests/games-vault.Tests/NosebleedSessionManagerTests.cs` where process-dependent parts can be abstracted; otherwise isolate pure snapshot formatting.

**API shape:**

Add public methods:

- `IReadOnlyList<NosebleedSessionSnapshot> GetSessions()`
- `bool TryStop(string sessionId, string reason = "manual")`
- `int CleanupExitedSessionsPublic()` or make cleanup happen inside `GetSessions()`.

Snapshot fields:

- `SessionId`
- `GameId`
- `FileId`
- `Port`
- `BaseUrl`
- `StartedUtc`
- `CorePath`
- `ContentPath`
- `ProcessId`
- `HasExited`
- `Runtime`

**Important:** Stop must kill the entire process tree, remove the dictionary entry, dispose the process, and later mark telemetry ended.

**Verification:**

Run:

```bash
dotnet build games-vault.sln -c Release
```

Expected: no compile errors; PlayServer still starts sessions.

---

## Task 4: Add orphan Nosebleed process discovery

**Objective:** Show suspicious standalone Nosebleed processes so Joel can kill instances left behind after app restarts.

**Files:**
- Create: `Nosebleed/NosebleedProcessInspector.cs`
- Modify: `Program.cs`
- Optional test: pure parser tests for Linux `/proc/<pid>/cmdline` command-line parsing.

**Implementation approach:**

- Enumerate `/proc/[0-9]+/cmdline` on Linux.
- Match processes where command line contains either:
  - configured `Nosebleed:BinaryPath`, or
  - executable name `nosebleed`, or
  - `--session-id games-vault-`.
- Exclude PIDs already known by `NosebleedSessionManager.GetSessions()`.
- Parse best-effort fields from args: `--listen`, `--session-id`, `--core`, `--content`.
- Return `NosebleedProcessSnapshot` records with PID, session id, listen address/port, core, content, started time if available, and `IsManaged=false`.

**Safety rules:**

- Only expose kill action for matching Nosebleed processes.
- Do not kill arbitrary processes by user-supplied PID unless the inspector still identifies it as Nosebleed at POST time.

**Verification:**

Run:

```bash
dotnet test tests/games-vault.Tests/games-vault.Tests.csproj
dotnet build games-vault.sln -c Release
```

Expected: tests/build pass.

---

## Task 5: Wire telemetry into PlayServer lifecycle

**Objective:** Record start, keepalive duration, and leave/stop end state for Nosebleed gameplay.

**Files:**
- Modify: `Controllers/GamesController.cs`
- Modify: `Models/ViewModels/ServerGamePlayViewModel.cs` if the view needs telemetry id/status.
- Modify: `Views/Games/PlayServer.cshtml` only if hidden fields or JS keepalive payloads need changes.

**Rules:**

- After `StartOrReuseAsync` succeeds, call telemetry `StartAsync(..., mode: "nosebleed", externalSessionId: session.Id)`.
- `KeepAliveServerSession` should update active duration using `TouchDurationAsync` after refreshing the seat.
- `LeaveServerSession` should release the viewer seat. Do not necessarily end the whole game session unless no seats remain; this can wait until manager/session stop for MVP.
- Manual session kill should call telemetry finish with reason `manual-stop`.

**Verification:**

Run:

```bash
dotnet build games-vault.sln -c Release
```

Expected: PlayServer compiles and existing player view still renders.

---

## Task 6: Build dashboard query/view model

**Objective:** Give Home/Index a single model with setup state, dashboard stats, and active sessions.

**Files:**
- Modify: `Models/ViewModels/HomeIndexViewModel.cs`
- Create: `Models/ViewModels/HomeDashboardViewModels.cs` if the model gets too large.
- Modify: `Controllers/HomeController.cs`

**View model additions:**

- `bool ShowDashboard`
- `int SystemsCount`
- `int GameFilesCount`
- `long TotalGameBytes`
- `TimeSpan TotalPlayTime`
- `int PlaySessionCount`
- `DashboardGameSummary? LastPlayedGame`
- `IReadOnlyList<DashboardGameSummary> TopPlayedGames`
- `IReadOnlyList<NosebleedSessionDashboardItem> ActiveNosebleedSessions`
- `IReadOnlyList<NosebleedProcessDashboardItem> OrphanNosebleedProcesses`

**Dashboard readiness logic:**

```csharp
ShowDashboard = PlaySessionCount > 0 || ActiveNosebleedSessions.Count > 0 || GamesCount > 0;
```

**Verification:**

Run:

```bash
dotnet build games-vault.sln -c Release
```

Expected: HomeController builds with all dependencies registered.

---

## Task 7: Replace Home view with dashboard + fallback setup

**Objective:** Render a useful home dashboard while preserving setup actions for fresh installs.

**Files:**
- Modify: `Views/Home/Index.cshtml`
- Modify: `wwwroot/css/site.css` if custom dashboard/jumbotron styling is needed.

**Layout:**

- Top row: title `Games Vault`, quick actions (`Add game`, `Browse`, `Sources`, `Jobs`).
- If `ShowDashboard`:
  - Jumbotron card: `Active Nosebleed Sessions` with big active count and preview cards.
  - Metrics cards: total play time, sessions, games, systems/files/storage.
  - Top games list.
  - Setup health card collapsed/lower priority.
- Else:
  - Keep current setup checklist and quick start cards.

**Live preview MVP:**

- Each active session card should show a preview panel with status text and a `Join`/`Open` button to `Games/PlayServer/{gameId}`.
- If Nosebleed exposes or later exposes a preview snapshot endpoint, add an `<img>`/canvas area that can poll it. For today, structure the DOM as `data-preview-url` so adding polling is a small follow-up.

**Verification:**

Run:

```bash
dotnet build games-vault.sln -c Release
curl -I http://127.0.0.1:8090/
```

Expected: build passes; home route returns 200 after deployment/restart.

---

## Task 8: Add session manager POST actions

**Objective:** Let Joel stop managed sessions and kill orphan candidates from the dashboard.

**Files:**
- Modify: `Controllers/HomeController.cs`
- Modify: `Views/Home/Index.cshtml`

**Actions:**

- `POST /Home/StopNosebleedSession` with antiforgery: takes `sessionId`, calls `NosebleedSessionManager.TryStop(sessionId)`, marks telemetry finished, redirects home with TempData.
- `POST /Home/KillNosebleedProcess` with antiforgery: takes `pid`, calls `NosebleedProcessInspector.TryKillIfNosebleed(pid)`, redirects home with TempData.

**Safety:**

- Re-identify the PID at POST time before killing.
- Include process command-line details in logs.
- Use `process.Kill(entireProcessTree: true)` only after matching Nosebleed.

**Verification:**

Run:

```bash
dotnet build games-vault.sln -c Release
```

Manual check:

- Start a Nosebleed game.
- Home shows the managed session.
- Click stop.
- `ss -tulpn` no longer shows that session port.

---

## Task 9: Deploy and verify on VAULT

**Objective:** Publish the dashboard safely to the running home-server service.

**Files:**
- No source changes unless deployment reveals configuration issues.

**Commands:**

```bash
cd /root/projects/games-vault
dotnet test tests/games-vault.Tests/games-vault.Tests.csproj
dotnet publish games-vault.csproj -c Release -o /opt/games-vault
systemctl restart games-vault
systemctl is-active games-vault
curl -I http://127.0.0.1:8090/
systemctl show games-vault -p ActiveEnterTimestamp --value
journalctl -u games-vault --since "<ActiveEnterTimestamp>" --no-pager
```

Expected:

- Tests pass.
- Service is active.
- Home returns 200.
- Logs since latest start have no severe new errors.

---

## Acceptance Criteria

- Home screen becomes dashboard-first once there are games, play telemetry, or active sessions.
- Setup workflow remains available for fresh/unfinished installs.
- Dashboard shows total play time and top/last played data once sessions exist.
- Active Nosebleed sessions appear prominently with game/session metadata.
- Managed sessions can be stopped from the UI.
- Orphan Nosebleed processes can be discovered and killed only after being revalidated as Nosebleed.
- `dotnet test` and `dotnet build -c Release` pass.
- Published VAULT service remains healthy on port `8090`.

## Deferred Follow-ups

- Rich real-time video thumbnails if Nosebleed adds a dedicated preview/snapshot endpoint.
- Multi-user lobby controls and per-viewer kick actions.
- Browser/Emscripten playtime telemetry separate from Nosebleed.
- Persistent session recovery across app restarts beyond orphan detection.
