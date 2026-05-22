# Nosebleed Mobile Controls, Debug HUD, Memory Watchers, and Users Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Improve the server-side Nosebleed player with reliable mobile D-pad touch behavior, user-controlled diagnostics, per-game memory monitoring for scores/state extraction, and first-class Games Vault users for ownership of scores/saves/play history.

**Architecture:** Keep the ASP.NET Core app as the orchestrator and persistence layer; keep Nosebleed as the libretro runtime. Client-only UI polish belongs in `Views/Games/PlayServer.cshtml` and `wwwroot/js/nosebleed-player/server-player.js`. Memory inspection needs a new authenticated Nosebleed runtime API plus Games Vault-side profile definitions and polling/storage services. User support should start with simple local profiles, then graduate to ASP.NET Core Identity only if passworded multi-device login is needed.

**Tech Stack:** ASP.NET Core MVC, EF Core + SQLite migrations, Razor views, vanilla JavaScript Pointer Events, Rust Nosebleed/libretro sidecar.

---

## Current State

- Server-side player page: `Views/Games/PlayServer.cshtml`.
- Server-side player client: `wwwroot/js/nosebleed-player/server-player.js`.
- Touch buttons already use Pointer Events, `setPointerCapture`, and `touchControls` set membership.
- Current D-pad is four separate `.touch-btn.dpad` elements inside a draggable `.pad-cluster`; swiping from one button to another does **not** change the active direction because captured pointer events stay with the original button.
- Diagnostics are always visible as chips/HUD in the player shell: status, video, input, pad, FPS/drop stats, gamepad test panel.
- Gameplay telemetry exists in `Models/GamePlaySession.cs` and `Gameplay/GamePlayTelemetryService.cs`, but there is no `UserId` field.
- There are no app users/profiles yet; searches found no ASP.NET Identity or local user model.
- Nosebleed currently has no exposed runtime memory API. `apps/nosebleed/src/libretro.rs` loads libretro symbols but does not load `retro_get_memory_data` / `retro_get_memory_size`.

---

## Acceptance Criteria

1. **D-pad swipe works:** On mobile, pressing down on the D-pad and sliding between directions updates the active direction without lifting the finger. Diagonals are supported: sliding into an upper-left, upper-right, lower-left, or lower-right zone sends both directional buttons together.
2. **Debug toggle works:** Diagnostics/stats are hidden by default, can be toggled from a normal UI button outside the player viewport, and then remember the current browser's last state. The toggle must not remove essential controls like Connect, Fullscreen, Sound, or layout controls.
3. **Memory watcher MVP works:** A per-game profile can define watched memory addresses, Nosebleed can return those bytes safely, and Games Vault can poll/store derived values for an active session.
4. **Users MVP works:** A player can select or create a local Games Vault profile from the UI. Play sessions, high scores/derived stats, and future saves can be associated with that user. Full auth/profile expansion is explicitly deferred.
5. **Sonic 2 Game Gear derived stat works:** The first score-like metric is `highest ring count * lives`, because Sonic 2 Game Gear does not expose a traditional high score. The score profile stores the current/best observed ring count, current lives, and derived score value per user.
6. **No orphan sessions:** Any route/test that starts Nosebleed must include cleanup verification (`pgrep -a nosebleed` or session manager stop).

---

## Phase 1 — Fix Mobile D-pad Swipe Reliability

### Task 1.1: Add a D-pad hit-test helper in the client script

**Objective:** Decouple D-pad direction selection from individual button pointer capture.

**Files:**
- Modify: `wwwroot/js/nosebleed-player/server-player.js`
- Test manually in browser; optional unit-like Playwright later.

**Implementation notes:**
- Treat `.pad-cluster[data-control-group="dpad"]` as the pointer surface.
- On pointerdown/move inside the D-pad cluster, compute pointer position relative to cluster center.
- Apply directions based on threshold and allow two directions at once:
  - `dx < -0.22` => `left`
  - `dx > 0.22` => `right`
  - `dy < -0.22` => `up`
  - `dy > 0.22` => `down`
  - examples: upper-left sends `up` + `left`; lower-right sends `down` + `right`.
- If the finger is close to center and no threshold is crossed, keep the nearest previous D-pad direction until the pointer leaves/releases to avoid flicker.
- Release all D-pad directions on pointerup/cancel/lostpointercapture.
- Keep face/menu buttons on their existing per-button behavior.

**Suggested functions:**
- `setDirectionalTouch(nextDirections)`
- `clearDpadTouch()`
- `updateDpadFromPointer(ev, cluster)`
- `isDpadButton(button)`

**Verification:**
- Load `/Games/PlayServer/6` on phone.
- Press D-pad center/left and slide to up/right/down without lifting.
- Verify visual `.is-pressed` moves with the finger and input continues to send.
- Slide into corners and verify both relevant visual buttons show `.is-pressed` and both directions are sent.
- Confirm face buttons still work as distinct button presses.

### Task 1.2: Avoid duplicate D-pad events from child buttons

**Objective:** Prevent individual D-pad child buttons from fighting the cluster-level pointer handler.

**Files:**
- Modify: `wwwroot/js/nosebleed-player/server-player.js`

**Implementation notes:**
- In the existing `for (const button of touchButtons)` loop, skip per-button pointer handlers for dpad buttons.
- Bind D-pad pointer events once on the cluster.
- Do not break layout editing: if `layoutEditMode` is true, dragging the group wins and no game input is sent.

**Verification:**
- Swipe D-pad in all four directions.
- Unlock layout and drag the D-pad group; confirm no game input is sent while editing.
- Save layout; reload; confirm D-pad still swipes.

### Task 1.3: Add lightweight UI regression markers

**Objective:** Make future grep verification possible without browser automation.

**Files:**
- Modify: `Views/Games/PlayServer.cshtml`

**Implementation notes:**
- Add `data-dpad-surface="true"` to the D-pad cluster.
- Preserve `data-button="up|down|left|right"` on direction buttons for visual state.

**Verification command:**

```bash
curl -s http://127.0.0.1:8090/Games/PlayServer/6 | grep -E 'data-dpad-surface|data-button="up"|data-button="right"'
```

Expected: all markers present.

---

## Phase 2 — Toggle Debug/Diagnostics Outside the Player

### Task 2.1: Define diagnostic levels

**Objective:** Separate essential controls from optional debug noise.

**Files:**
- Modify: `Views/Games/PlayServer.cshtml`
- Modify: `wwwroot/js/nosebleed-player/server-player.js`

**Diagnostics to hide/show:**
- Hide/show: status chip row, FPS/drop chip, gamepad test panel, verbose text status, session host/session IDs if desired.
- Always visible: Connect/Reconnect, Fullscreen, Sound, Unlock/Save layout, Touch controls toggle, Leave.

### Task 2.2: Add a dashboard-side toggle button

**Objective:** Add a button outside the player viewport so it does not obscure gameplay.

**Files:**
- Modify: `Views/Games/PlayServer.cshtml`

**Implementation notes:**
- Add button near existing top controls/card toolbar:
  - id: `nosebleed-debug-toggle`
  - text: `Show diagnostics` / `Hide diagnostics`
  - Bootstrap style: `btn btn-outline-secondary`
- Wrap optional diagnostics in a container with id `nosebleed-debug-panel` and class `d-none` by default.
- The in-player overlay should not gain another debug button unless needed later.

### Task 2.3: Persist diagnostics preference per device

**Objective:** Hide stats/diagnostics by default, then respect Joel's preference on that browser without requiring login yet.

**Files:**
- Modify: `wwwroot/js/nosebleed-player/server-player.js`

**Implementation notes:**
- Add localStorage key: `games-vault:nosebleed-debug-visible`.
- On load, default to hidden when no saved value exists.
- If saved value exists, apply saved value.
- On toggle, update DOM classes and button text.

**Verification:**
- Open page: diagnostics hidden by default.
- Tap `Show diagnostics`: FPS/status/gamepad test controls appear.
- Reload page: state persists.
- Tap `Hide diagnostics`: diagnostics disappear and remain hidden after reload.

---

## Phase 3 — Per-game Memory Monitoring Profiles

### Sonic 2 Game Gear MVP target

Use Sonic The Hedgehog 2 for Sega Game Gear as the first reverse-engineering target. Since the game does not have a traditional high-score field, derive a score-like stat as:

```text
highest observed ring count * current lives
```

Profile watches needed:

- `rings_current`: current ring count in RAM.
- `lives_current`: current lives in RAM.
- `rings_highest`: derived in Games Vault by keeping max `rings_current` observed during a session.
- `derived_score`: `rings_highest * lives_current`, persisted per `GameUser` and game.

Do not hard-code the final memory addresses in the plan until they are confirmed by the memory API spike. Add them through the memory profile UI/seed data once discovered.

### Task 3.1: Spike Nosebleed memory read support

**Objective:** Confirm Nosebleed can safely read libretro core memory regions.

**Repository:** `/root/projects/nosebleed`

**Files:**
- Modify: `apps/nosebleed/src/libretro.rs`
- Modify: `apps/nosebleed/src/server.rs`
- Add tests if there is an existing Rust test pattern.

**Implementation notes:**
- Load optional symbols:
  - `retro_get_memory_data(id: u32) -> *mut c_void`
  - `retro_get_memory_size(id: u32) -> usize`
- Support at least libretro memory id `RETRO_MEMORY_SAVE_RAM = 0` first.
- Consider later ids: RTC, system RAM, video RAM, but MVP should not promise them.
- Create a thread-safe `MemoryInspector` that can snapshot allowed ranges after `retro_run` ticks.
- Add authenticated endpoint, likely:
  - `GET /session/memory?region=save_ram&offset=0x1234&length=4`
  - response: `{ region, offset, length, bytesBase64, littleEndianU32? }`
- Enforce max length, e.g. 256 bytes per request.
- Require the same Nosebleed auth token already used for WebSockets.

**Verification:**
- Start a known ROM/core.
- Call memory endpoint with valid token and small range.
- Confirm 200 with deterministic shape.
- Confirm invalid offset/length returns 400.
- Confirm missing/invalid token returns 401/403.

### Task 3.2: Add Games Vault memory profile models

**Objective:** Store per-game definitions for watched memory addresses.

**Repository:** `/root/projects/games-vault`

**Files:**
- Create: `Models/GameMemoryProfile.cs`
- Create: `Models/GameMemoryWatch.cs`
- Create: `Models/GameMemorySample.cs` or `Models/GameScoreObservation.cs`
- Modify: `Data/AppDbContext.cs`
- Add migration: `dotnet ef migrations add AddGameMemoryProfiles`

**Model sketch:**
- `GameMemoryProfile`: `Id`, `GameId`, `Name`, `SystemName`, `Enabled`, `CreatedUtc`, `UpdatedUtc`.
- `GameMemoryWatch`: `Id`, `GameMemoryProfileId`, `Key`, `Label`, `Region`, `Offset`, `Length`, `ValueType`, `Endian`, `Scale`, `Expression`, `IsScore`.
- `GameScoreObservation`: `Id`, `GameId`, `GameMemoryWatchId`, `GameUserId?`, `ExternalSessionId`, `RawValue`, `NumericValue`, `ObservedUtc`.

**YAGNI boundary:**
- Do not build a full scripting language first. Start with primitive extractors: `u8`, `u16`, `u32`, `bcd`, `bytes`, endian flag.
- For the Sonic 2 MVP, support one simple derived expression shape: `max(rings_current) * lives_current`. Implement this in C# service logic rather than a generic expression engine.

### Task 3.3: Add memory polling service in Games Vault

**Objective:** Poll active Nosebleed sessions and persist score/state observations.

**Files:**
- Create: `Gameplay/NosebleedMemoryMonitorService.cs`
- Modify: `Program.cs`
- Modify: `Nosebleed/NosebleedSession.cs` or snapshot model if needed.

**Implementation notes:**
- Hosted service runs every 1-5 seconds for active sessions only.
- Query profile watches for the session's `GameId`.
- Call Nosebleed memory endpoint using the existing session `BaseUrl` and signed/admin token.
- Convert bytes to values using the profile watch definition.
- Store only changed values or high-score improvements to avoid DB spam.

**Verification:**
- With a fake/stub Nosebleed memory endpoint, test conversion and persistence.
- With live Nosebleed, manually observe a score-like address once known.

### Task 3.4: Add profile management UI

**Objective:** Let us define profiles per game without editing DB manually.

**Files:**
- Create: `Controllers/GameMemoryProfilesController.cs`
- Create: `Views/GameMemoryProfiles/Index.cshtml`
- Create: `Views/GameMemoryProfiles/Edit.cshtml`
- Modify: `Views/Games/Details.cshtml`

**Implementation notes:**
- Link from game details: `Memory profiles`.
- MVP fields: Label, Region, Offset hex, Length, Type, Endian, IsScore.
- Add a `Test read` button only when there is an active session for the game.

---

## Phase 4 — Users / Local Profiles

### Task 4.1: Choose MVP identity shape

**Decision:** Start with local player profiles that can be created from the UI, not full password login.

**Reasoning:** This is a LAN home-server arcade. High scores/saves need attribution before they need authentication. ASP.NET Identity/full profiles can come later if remote or private multi-user access matters.

### Task 4.2: Add local user/profile model

**Objective:** Create durable user IDs for play sessions, scores, saves, and settings.

**Files:**
- Create: `Models/GameUser.cs`
- Modify: `Models/GamePlaySession.cs`
- Modify: `Data/AppDbContext.cs`
- Add migration: `dotnet ef migrations add AddGameUsers`

**Model sketch:**
- `GameUser`: `Id`, `DisplayName`, `Slug`, `AvatarColor`, `IsDefault`, `CreatedUtc`, `LastSeenUtc`.
- Add nullable `GameUserId` to `GamePlaySession`.
- Later tables: `GameSave`, `HighScore`, `UserPreference`.

### Task 4.3: Add profile picker UI

**Objective:** Let a browser select the active user before launching/playing.

**Files:**
- Create: `Controllers/GameUsersController.cs`
- Create: `Views/GameUsers/Index.cshtml`
- Modify: `Views/Shared/_Layout.cshtml`
- Modify: `Views/Games/PlayServer.cshtml`

**Implementation notes:**
- Store selected profile id in signed cookie: `games_vault_user`.
- Header shows current user and a `Switch` link.
- If no user exists, prompt to create a local profile. Keep a simple one-field create form (`DisplayName`) available from the picker.
- Add quick switch on PlayServer page so someone can change player before connecting.

### Task 4.4: Thread user through Nosebleed session and telemetry

**Objective:** Tie active player to gameplay sessions and future high scores.

**Files:**
- Modify: `Controllers/GamesController.cs`
- Modify: `Gameplay/GamePlayTelemetryService.cs`
- Modify: `Nosebleed/NosebleedTicketSigner.cs` if token subject should include user id.
- Modify: `Nosebleed/NosebleedSessionManager.cs` if session reuse should consider user or allow multiple seats.

**Implementation notes:**
- Include `GameUserId` in `GamePlayTelemetryService.StartAsync`.
- Include user id/display name in Nosebleed ticket claims for audit/debug, but continue enforcing allowed ports server-side.
- Reuse policy needs a decision:
  - Same game/session can be shared by multiple users as seats, or
  - Single-player session belongs to one `GameUserId`.
- MVP: keep current reuse by game/file/core/content, but assign seats by viewer cookie + user id for observability.

**Verification:**
- Select `Joel` profile.
- Start Sonic.
- Confirm `GamePlaySessions.GameUserId` points to Joel.
- Switch to another profile; confirm next session/seat attribution differs.

---

## Recommended Build Order

1. **D-pad swipe fix** — immediate mobile playability, no DB changes.
2. **Debug toggle** — quick UI quality win, no DB changes.
3. **Local users** — enables attribution before high score work lands.
4. **Nosebleed memory API spike** — technical risk reducer.
5. **Memory profiles + high score persistence** — depends on users and memory API.

---

## Verification Commands

From `/root/projects/games-vault`:

```bash
dotnet build -c Release
dotnet test
```

After deploy:

```bash
dotnet publish games-vault.csproj -c Release -o /opt/games-vault
systemctl restart games-vault
systemctl status games-vault --no-pager | cat
curl -I http://127.0.0.1:8090/Games/PlayServer/6
journalctl -u games-vault --since '5 minutes ago' --no-pager | grep -E 'fail:|crit:|Unhandled|Exception' || true
pgrep -a nosebleed || true
```

For Nosebleed repository `/root/projects/nosebleed`:

```bash
cargo test
cargo build --release -p nosebleed
```

---

## Open Questions

Resolved by Joel:

1. D-pad swipe should support diagonals.
2. Diagnostics/stats should be hidden by default, with browser-local persistence after toggling.
3. Users should start as a local profile picker with create-new-profile support; full profiles/auth can come later.
4. First memory target is Sonic 2 Game Gear, using derived score `highest ring count * lives` because there is no high score.

Still open:

1. Exact Sonic 2 Game Gear memory addresses for current rings and lives must be discovered with the Nosebleed memory API spike.
