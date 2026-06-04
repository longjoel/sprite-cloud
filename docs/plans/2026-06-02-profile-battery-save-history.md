# Profile Battery Save History Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Implement per-profile battery save persistence for non-arcade play as an append-only revision history, while keeping arcade sessions fully ephemeral and adding manual `.sav`/`.srm` upload support.

**Architecture:** Add a dedicated profile-owned battery-save domain instead of mutating `GamePlayerFiles` in place. Model a logical save stream (`ProfileGameSave`) plus immutable revisions (`ProfileGameSaveRevision`), restore the latest revision into a session-specific runtime workspace before non-arcade play starts, append a new revision only when bytes change, and skip the entire persistence pipeline for arcade sessions. Keep runtime writes in the Nosebleed session workspace, but add a Games Vault service layer that prepares profile save inputs and snapshots output files into durable storage under a separate library root.

**Tech Stack:** ASP.NET Core MVC, EF Core/SQLite, existing `CurrentProfileService`, `GamePlayRoomService`, `ArcadeController`, `NosebleedSessionManager`, `GamePlayTelemetryService`, `GameFileStorage`-style storage helpers, xUnit with in-memory SQLite tests.

---

## Current State Snapshot (important)

- `NosebleedSessionManager.StartOrReuseAsync(...)` currently starts a Nosebleed process from a ROM path and a shared `NosebleedOptions.SessionRoot`, but it has no hook for preparing/restoring per-profile save files before launch.
- Standalone room creation is profile-aware (`GamePlayRoom.CreatedByProfileId`), and arcade rooms are explicitly marked `IsArcadeBound = true` in `GamePlayRoomService` / `ArcadeController`.
- Arcade player sessions are already a separate mode (`arcade-free-play`) and should remain strictly ephemeral.
- `CurrentProfileService.GetCurrentAsync(...)` already resolves the active signed-in profile, so profile ownership can be enforced server-side.
- `GamePlayerFile` is currently a flat mutable blob table keyed by `(GameId, Kind, Key, FileName)` with no `ProfileId` and no immutable revision history; it is the wrong shape for append-only profile timelines.
- The current web-player sync patch (`Web/RetroArchWebPlayerPatch.cs`) restores/uploads `userdata` files, but that logic is game-scoped and not the correct storage contract for this new server-play battery-save feature.
- On live disk, `/srv/storage/games-vault/nosebleed/sessions` is accumulating old session folders, so we must be careful to separate transient runtime outputs from durable save history and not rely on session-root retention as persistence.

---

## Product Rules to Preserve

1. **Non-arcade play**
   - Restore the latest battery save revision for the current profile before the game starts.
   - Append a new immutable revision whenever the battery-save bytes change.
   - Never mix save history between profiles.

2. **Arcade play**
   - Never restore a prior battery save.
   - Never append a durable battery-save revision.
   - Session outputs die with the arcade runtime, like unplugging the cabinet.

3. **Revision history**
   - Every meaningful changed write becomes a new immutable revision.
   - Identical bytes should not produce duplicate revisions.
   - Manual uploads join the same revision timeline and can become the active latest revision.

4. **Default load + rewind UX**
   - Non-arcade play should restore the **latest** battery save revision by default with no extra picker step.
   - Rewinding should be implemented as selecting an older revision from a dropdown/history chooser and then reloading the player/session onto that selected revision.
   - This is revision-based rewind via historical battery saves, not emulator-style in-memory rewind.

---

## Scope for this feature

### In scope now
1. Per-profile battery save streams.
2. Immutable timestamped battery save revisions.
3. Restore latest revision into non-arcade sessions.
4. Append changed revisions during/after non-arcade sessions.
5. Strict arcade opt-out.
6. Manual upload of battery save files (`.sav`, `.srm`, plus small allowlist for adjacent SRAM formats if needed).
7. Basic server-side listing/history endpoints or service methods needed to support current/latest resolution and later UI work.

### Explicitly deferred
- Save states.
- Rich progression/timeline UI.
- Export/download UI.
- Revision labels/notes.
- Retention compaction/pruning policy.
- Browser RetroArch save-system migration to the same schema (can follow later once server-play path is stable).

---

## Proposed data model

### `ProfileGameSave`
Logical save stream identity.

Fields:
- `Id`
- `ProfileId`
- `Profile`
- `GameId`
- `Game`
- `GameFileId`
- `GameFile`
- `SystemName`
- `CoreKey`
- `Kind` (v1 always `battery`)
- `Key` (normalized relative runtime path, e.g. `default` or subdir key)
- `FileName`
- `LatestRevisionId`
- `LatestRevision`
- `CreatedUtc`
- `UpdatedUtc`

Indexes:
- unique on `(ProfileId, GameId, GameFileId, Kind, Key, FileName, CoreKey)`
- index on `(ProfileId, UpdatedUtc)`

### `ProfileGameSaveRevision`
Immutable append-only revision row.

Fields:
- `Id`
- `ProfileGameSaveId`
- `ProfileGameSave`
- `RevisionTimestampUtc`
- `StoragePath`
- `SizeBytes`
- `Sha256`
- `Source` (`runtime`, `upload`)
- `GamePlaySessionId` nullable
- `OriginalUploadFileName` nullable
- `CreatedUtc`

Indexes:
- index on `(ProfileGameSaveId, RevisionTimestampUtc DESC)`
- unique on `(ProfileGameSaveId, Sha256, SizeBytes)` only if we decide to prevent duplicate identical bytes globally per stream; otherwise enforce dedupe in service only.

### Keep `GamePlayerFile` untouched for now
Do **not** mutate existing `GamePlayerFile` to carry append-only history. It should remain isolated from this feature so we can ship battery-save history without destabilizing current web-player userdata behavior.

---

## Proposed storage layout

Durable profile save revisions:
- `LibraryRoot/profile-saves/profiles/{profileId}/games/{gameId}/files/{gameFileId}/battery/{saveId}/{timestamp}-{sha256short}{ext}`

Examples:
- `profile-saves/profiles/12/games/88/files/144/battery/301/20260602T231455Z-a1b2c3d4.srm`
- `profile-saves/profiles/12/games/88/files/144/battery/301/20260602T234012Z-f9e8d7c6.sav`

Transient runtime workspace remains under Nosebleed session root and must not be treated as durable storage.

---

## Runtime policy model

Add a single policy resolver rather than scattering `if (arcade)` branches:

- `BatterySavePolicy.None` — arcade sessions and other explicitly ephemeral contexts.
- `BatterySavePolicy.PerProfile(profileId)` — normal room play for a signed-in persistent profile.

Rule for v1 guest/ephemeral child profiles:
- If `profile.IsEphemeral == true`, treat as `None` unless product says otherwise later.
- This avoids promising durable history for guest identities.

---

## Task 1: Add battery save domain models and migration

**Objective:** Create a schema that supports immutable per-profile battery save history without overloading `GamePlayerFile`.

**Files:**
- Create: `Models/ProfileGameSave.cs`
- Create: `Models/ProfileGameSaveRevision.cs`
- Modify: `Data/AppDbContext.cs`
- Create: `Migrations/<timestamp>_AddProfileBatterySaveHistory.cs`
- Test: `tests/games-vault.Tests/ProfileGameSaveSchemaTests.cs`

**Step 1: Write failing schema tests**

Create `tests/games-vault.Tests/ProfileGameSaveSchemaTests.cs` with tests that:
- create an in-memory SQLite `AppDbContext`
- call `EnsureCreatedAsync()`
- verify `DbSet<ProfileGameSave>` and `DbSet<ProfileGameSaveRevision>` are queryable
- verify a `ProfileGameSave` can reference a `UserProfile`, `Game`, `GameFile`, and latest revision
- verify multiple revisions can exist for one logical save stream

**Step 2: Run test to verify failure**

Run:
```bash
dotnet test --filter ProfileGameSaveSchemaTests
```
Expected: FAIL — missing models / DbSets.

**Step 3: Implement minimal models**

Model details:
- `ProfileGameSave` owns the logical stream and latest revision pointer.
- `ProfileGameSaveRevision` stores immutable storage metadata only; no mutable “current bytes” column.
- Use explicit `string Kind = "battery"` in tests and seed paths.

**Step 4: Wire AppDbContext**

In `Data/AppDbContext.cs`:
- add `DbSet<ProfileGameSave>`
- add `DbSet<ProfileGameSaveRevision>`
- configure FK relationships and indexes
- keep delete behavior safe:
  - deleting `ProfileGameSave` cascades to revisions
  - deleting `LatestRevisionId` should not create a cycle; use `DeleteBehavior.Restrict` on the latest pointer

**Step 5: Create migration and verify**

Run:
```bash
dotnet ef migrations add AddProfileBatterySaveHistory
dotnet test --filter ProfileGameSaveSchemaTests
```
Expected: PASS.

**Step 6: Commit**

```bash
git add Models/ProfileGameSave.cs Models/ProfileGameSaveRevision.cs Data/AppDbContext.cs Migrations tests/games-vault.Tests/ProfileGameSaveSchemaTests.cs
git commit -m "feat: add profile battery save history schema"
```

---

## Task 2: Add durable battery save storage helper

**Objective:** Provide a storage abstraction for immutable battery save revisions similar to `GameFileStorage` / `SystemFileStorage`.

**Files:**
- Create: `Libretro/Import/ProfileGameSaveStorage.cs`
- Modify: `Libretro/Import/LibraryStorageOptions.cs`
- Modify: `Program.cs`
- Test: `tests/games-vault.Tests/ProfileGameSaveStorageTests.cs`

**Step 1: Write failing storage tests**

Add tests covering:
- relative storage path generation under configured library root
- safe `GetAbsolutePath(...)` validation rejecting path traversal
- storing a revision creates a file at a timestamped immutable path
- same logical save can store many revision files without overwriting earlier revisions

**Step 2: Run test to verify failure**

```bash
dotnet test --filter ProfileGameSaveStorageTests
```
Expected: FAIL — missing storage service.

**Step 3: Implement storage service**

Responsibilities:
- resolve durable root from `LibraryStorageOptions` (new option such as `ProfileSaveRootPath`, defaulting under `App_Data/library/profile-saves` or configured library root)
- store a revision file from a stream with caller-provided path pieces and extension
- return relative durable storage path
- resolve absolute durable path from relative path safely

**Step 4: Register service**

In `Program.cs` add the storage service to DI using existing library configuration pattern.

**Step 5: Verify tests pass**

```bash
dotnet test --filter ProfileGameSaveStorageTests
```

**Step 6: Commit**

```bash
git add Libretro/Import/ProfileGameSaveStorage.cs Libretro/Import/LibraryStorageOptions.cs Program.cs tests/games-vault.Tests/ProfileGameSaveStorageTests.cs
git commit -m "feat: add immutable profile save revision storage"
```

---

## Task 3: Add battery save policy and profile eligibility resolver

**Objective:** Centralize whether a session may use durable battery saves.

**Files:**
- Create: `Gameplay/BatterySavePolicy.cs`
- Create: `Gameplay/BatterySavePolicyResolver.cs`
- Modify: `Program.cs`
- Test: `tests/games-vault.Tests/BatterySavePolicyResolverTests.cs`

**Step 1: Write failing tests**

Cases:
- arcade room => `None`
- standalone room + persistent profile => `PerProfile(profileId)`
- standalone room + no profile => `None`
- standalone room + ephemeral guest profile => `None`

**Step 2: Implement resolver**

Resolver inputs:
- `GamePlayRoom room`
- `UserProfile? profile`

Behavior:
- `room.IsArcadeBound == true` => `None`
- `profile is null` => `None`
- `profile.IsEphemeral == true` => `None`
- else => `PerProfile(profile.Id)`

**Step 3: Verify**

```bash
dotnet test --filter BatterySavePolicyResolverTests
```

**Step 4: Commit**

```bash
git add Gameplay/BatterySavePolicy.cs Gameplay/BatterySavePolicyResolver.cs Program.cs tests/games-vault.Tests/BatterySavePolicyResolverTests.cs
git commit -m "feat: add battery save persistence policy resolver"
```

---

## Task 4: Add battery save history service (append-only + dedupe)

**Objective:** Implement the core application service that finds/creates logical save streams, appends immutable revisions, and resolves latest active revision.

**Files:**
- Create: `Gameplay/ProfileBatterySaveService.cs`
- Create: `Gameplay/ProfileBatterySaveModels.cs`
- Modify: `Program.cs`
- Test: `tests/games-vault.Tests/ProfileBatterySaveServiceTests.cs`

**Step 1: Write failing service tests**

Cover:
- appending the first revision creates a save stream and revision
- appending changed bytes creates a second revision and updates `LatestRevisionId`
- appending identical bytes does not create a duplicate revision
- querying latest revision returns most recent stream revision
- streams are isolated by `ProfileId`
- streams are isolated by `GameFileId`

**Step 2: Run test to verify failure**

```bash
dotnet test --filter ProfileBatterySaveServiceTests
```

**Step 3: Implement service**

Methods to include:
- `GetPolicyAwareLatestAsync(...)`
- `AppendRuntimeRevisionAsync(...)`
- `AppendUploadedRevisionAsync(...)`
- `GetHistoryAsync(...)`
- `FindOrCreateSaveAsync(...)`

Implementation details:
- compute SHA-256 for incoming bytes
- compare with latest revision hash/size
- only append a new immutable file + row if bytes changed
- update `ProfileGameSave.LatestRevisionId` and `UpdatedUtc`

**Step 4: Verify**

```bash
dotnet test --filter ProfileBatterySaveServiceTests
```

**Step 5: Commit**

```bash
git add Gameplay/ProfileBatterySaveService.cs Gameplay/ProfileBatterySaveModels.cs Program.cs tests/games-vault.Tests/ProfileBatterySaveServiceTests.cs
git commit -m "feat: add append-only profile battery save service"
```

---

## Task 5: Extend Nosebleed startup contract to prepare a per-session battery save workspace

**Objective:** Give the app a place to materialize latest battery-save bytes into the upcoming session before the emulator boots.

**Files:**
- Modify: `Nosebleed/NosebleedSessionManager.cs`
- Create: `Nosebleed/NosebleedSessionStartOptions.cs`
- Create: `Nosebleed/NosebleedRuntimePaths.cs`
- Test: `tests/games-vault.Tests/NosebleedSessionManagerBatterySaveTests.cs`

**Step 1: Write failing tests**

Test that when start options include a prepared battery-save callback or runtime-path builder:
- a deterministic per-session save directory is created under the session workspace
- the callback runs before process launch
- arcade/no-policy mode does not attempt save preparation

**Step 2: Implement minimal extensibility**

Add a start options object for `StartOrReuseAsync(...)` with fields like:
- `InstanceKey`
- `PrepareSessionAsync` callback or explicit prepared save inputs
- future-proof room/profile metadata if needed

Also add a helper record exposing runtime locations we control, such as:
- session root directory
- content copy path (if enabled)
- battery save directory

**Step 3: Preserve current behavior**

All existing callers continue to work with defaults.

**Step 4: Verify**

```bash
dotnet test --filter NosebleedSessionManagerBatterySaveTests
```

**Step 5: Commit**

```bash
git add Nosebleed/NosebleedSessionManager.cs Nosebleed/NosebleedSessionStartOptions.cs Nosebleed/NosebleedRuntimePaths.cs tests/games-vault.Tests/NosebleedSessionManagerBatterySaveTests.cs
git commit -m "feat: add nosebleed session save-workspace hooks"
```

---

## Task 6: Add runtime materialization + capture service for battery saves

**Objective:** Restore latest battery saves into a normal session workspace and append changed revisions from runtime outputs.

**Files:**
- Create: `Gameplay/BatterySaveRuntimeSyncService.cs`
- Modify: `Gameplay/GamePlayRoomService.cs`
- Modify: `Controllers/ArcadeController.cs`
- Test: `tests/games-vault.Tests/BatterySaveRuntimeSyncServiceTests.cs`
- Test: `tests/games-vault.Tests/GamePlayRoomServiceBatterySaveTests.cs`

**Step 1: Write failing tests**

Cases:
- standalone room with persistent profile restores latest revision into runtime workspace
- arcade room skips restore entirely
- changed runtime battery-save file appends a new revision
- unchanged runtime file appends nothing

**Step 2: Implement runtime sync service**

Responsibilities:
- derive the logical save key/file name from runtime path
- copy latest durable revision into runtime workspace before launch
- after runtime write discovery, pass changed files into `ProfileBatterySaveService.AppendRuntimeRevisionAsync(...)`

**Step 3: Wire standalone room creation/join path**

In `GamePlayRoomService.CreateRoomAsync(...)`:
- resolve current profile
- compute battery save policy
- pass preparation hook/options into `NosebleedSessionManager.StartOrReuseAsync(...)`

In `ArcadeController` / arcade room flow:
- explicitly use `BatterySavePolicy.None`

**Step 4: Decide capture timing for v1**

Start with:
- final flush/capture on room shutdown
- optional manual periodic poll later

This is the safest first cut.

**Step 5: Verify**

```bash
dotnet test --filter BatterySaveRuntimeSyncServiceTests|GamePlayRoomServiceBatterySaveTests
```

**Step 6: Commit**

```bash
git add Gameplay/BatterySaveRuntimeSyncService.cs Gameplay/GamePlayRoomService.cs Controllers/ArcadeController.cs tests/games-vault.Tests/BatterySaveRuntimeSyncServiceTests.cs tests/games-vault.Tests/GamePlayRoomServiceBatterySaveTests.cs
git commit -m "feat: restore and capture profile battery saves for standalone sessions"
```

---

## Task 7: Trigger final battery-save capture on standalone room shutdown

**Objective:** Ensure the last meaningful battery-save write is persisted when a non-arcade room closes.

**Files:**
- Modify: `Gameplay/GamePlayRoomService.cs`
- Possibly modify: `Gameplay/GamePlayTelemetryService.cs` (only if session correlation is needed)
- Test: `tests/games-vault.Tests/GamePlayRoomShutdownBatterySaveTests.cs`

**Step 1: Write failing tests**

- closing a standalone room with changed battery-save output appends a revision
- closing a standalone room with unchanged output appends nothing
- closing an arcade room appends nothing

**Step 2: Implement**

Before `nosebleedSessions.TryStop(...)` in standalone close path:
- inspect runtime save output files
- append changed revisions for non-arcade/persistent policy only
- then stop the process

**Step 3: Verify**

```bash
dotnet test --filter GamePlayRoomShutdownBatterySaveTests
```

**Step 4: Commit**

```bash
git add Gameplay/GamePlayRoomService.cs tests/games-vault.Tests/GamePlayRoomShutdownBatterySaveTests.cs
git commit -m "feat: persist final battery save revision on room shutdown"
```

---

## Task 8: Add manual battery save upload flow

**Objective:** Let the current profile upload `.sav`/`.srm` files into the same immutable revision timeline.

**Files:**
- Create: `Controllers/ProfileBatterySavesController.cs`
- Create: `Models/ViewModels/ProfileBatterySaveUploadViewModel.cs`
- Create or modify: `Views/Games/...` or `Views/ProfileBatterySaves/...`
- Test: `tests/games-vault.Tests/ProfileBatterySaveUploadTests.cs`

**Step 1: Write failing tests**

Cover:
- upload requires signed-in persistent profile
- upload rejects arcade context / missing profile
- upload rejects missing file
- upload accepts `.sav` / `.srm`
- upload creates a new immutable revision with `Source = upload`
- duplicate upload of identical bytes does not create a second revision

**Step 2: Implement controller**

Suggested endpoints:
- `GET /ProfileBatterySaves/Upload?gameId=...&gameFileId=...`
- `POST /ProfileBatterySaves/Upload`
- maybe `GET /ProfileBatterySaves/History?gameId=...&gameFileId=...`

Validation:
- current profile must exist and not be ephemeral
- file extension allowlist
- size cap
- antiforgery token

**Step 3: Implement service call**

Controller passes uploaded file stream to `AppendUploadedRevisionAsync(...)`.

**Step 4: Verify**

```bash
dotnet test --filter ProfileBatterySaveUploadTests
```

**Step 5: Commit**

```bash
git add Controllers/ProfileBatterySavesController.cs Models/ViewModels/ProfileBatterySaveUploadViewModel.cs Views tests/games-vault.Tests/ProfileBatterySaveUploadTests.cs
git commit -m "feat: add profile battery save upload flow"
```

---

## Task 9: Add history query surface and rewind selection UX

**Objective:** Expose enough metadata to show save progression and allow revision-based rewind by reloading the player with a selected historical save.

**Files:**
- Modify: `Gameplay/ProfileBatterySaveService.cs`
- Create: `Models/ViewModels/ProfileBatterySaveHistoryViewModel.cs`
- Modify or create: `Controllers/ProfileBatterySavesController.cs` history/select actions
- Modify: `Controllers/GamesController.cs`
- Modify: `Models/ViewModels/ServerGamePlayViewModel.cs`
- Modify: `Views/Games/PlayServer.cshtml`
- Test: `tests/games-vault.Tests/ProfileBatterySaveHistoryTests.cs`
- Test: `tests/games-vault.Tests/ProfileBatterySaveRewindSelectionTests.cs`

**Step 1: Write failing tests**

- history ordered newest-first
- rows include timestamp, source, size, hash, original filename (if uploaded)
- only current profile can see its own history
- PlayServer model/view shows latest revision as current/default
- selecting an older revision posts a rewind target and reloads the player/session using that chosen revision

**Step 2: Implement**

Return rows suitable for future UI:
- current/latest marker
- revision timestamp
- source
- size
- SHA-256 short display
- session linkage if available

UI/flow details:
- Add a compact **Save history** dropdown/picker on `Views/Games/PlayServer.cshtml` for non-arcade sessions only.
- Default selected option should be the latest revision.
- Submitting an older revision should trigger a full player reload/new room start that uses that revision as the restore source.
- Keep the UX explicit: this is "Load save" / "Rewind to save", not a hidden automatic rollback.

**Step 3: Verify**

```bash
dotnet test --filter ProfileBatterySaveHistoryTests|ProfileBatterySaveRewindSelectionTests
```

**Step 4: Commit**

```bash
git add Gameplay/ProfileBatterySaveService.cs Models/ViewModels/ProfileBatterySaveHistoryViewModel.cs Controllers/ProfileBatterySavesController.cs Controllers/GamesController.cs Models/ViewModels/ServerGamePlayViewModel.cs Views/Games/PlayServer.cshtml tests/games-vault.Tests/ProfileBatterySaveHistoryTests.cs tests/games-vault.Tests/ProfileBatterySaveRewindSelectionTests.cs
git commit -m "feat: add battery save history queries and rewind selection ui"
```

---

## Task 10: Smoke-test the end-to-end flow and document operational notes

**Objective:** Prove the feature works for the user story “pick up and play from any device” and record caveats.

**Files:**
- Modify: `docs/plans/2026-06-02-profile-battery-save-history.md` (checklist/results section)
- Optionally create: `docs/notes/profile-battery-save-history.md`

**Step 1: Manual verification**

Scenarios:
1. Signed-in profile starts standalone room, plays, saves, exits.
2. Same profile on a second browser/device starts again and sees the latest battery save restored by default.
3. Same profile uploads a `.sav`/`.srm` and next session restores the uploaded revision if it is now latest.
4. Same profile selects an older save from the dropdown, reloads the player, and sees that historical revision restored.
5. Arcade cabinet never restores any prior save and never writes durable history.

**Step 2: Record exact commands**

```bash
dotnet test
dotnet build -c Release
```

If running on VAULT dev, also verify a real end-to-end session.

**Step 3: Commit**

```bash
git add docs/plans/2026-06-02-profile-battery-save-history.md
git commit -m "docs: record battery save history verification notes"
```

---

## Implementation notes / pitfalls

### 1. Do not treat session-root retention as save persistence
The live server already accumulates old session folders. Durable history must live under a dedicated profile-save root, not under `/srv/storage/games-vault/nosebleed/sessions`.

### 2. Do not persist guest/ephemeral child profiles in v1
A guest profile timeline complicates product expectations and cleanup. Return `BatterySavePolicy.None` for ephemeral profiles until intentionally supported.

### 3. Avoid duplicate revisions on no-op flushes
Many runtimes rewrite battery files without meaningful changes. Hash + size dedupe is required.

### 4. Keep arcade logic hard-walled
No restore, no upload, no append, no fallback behavior. Arcade should always boot clean.

### 5. Save key normalization matters
The logical identity of a battery save should come from normalized runtime path pieces (`Key` + `FileName`) so multi-file systems can work later.

### 6. Start with final-flush capture before periodic sync
Periodic sync can come later. First ship a reliable restore + shutdown-capture flow.

---

## Suggested first implementation slice

If we want to start immediately with the smallest high-value slice, do these first:
1. Task 1 — schema
2. Task 2 — storage helper
3. Task 3 — policy resolver
4. Task 4 — append-only save service

That gives us the durable data/storage core before touching live Nosebleed lifecycle code.

---

## Ready-to-run first commands

From repo root:

```bash
dotnet test --filter ProfileGameSaveSchemaTests
```

After adding Task 1 tests/models:

```bash
dotnet ef migrations add AddProfileBatterySaveHistory
dotnet test --filter ProfileGameSaveSchemaTests
dotnet build -c Release
```

---

## Success criteria

The feature is complete for v1 when:
- a persistent profile’s standalone game session restores its latest battery save automatically by default
- changed battery-save bytes create immutable timestamped revisions
- identical bytes do not create duplicate revisions
- manual upload creates a new revision in the same history
- a player can rewind by selecting an older save revision from a dropdown and reloading into that chosen revision
- arcade sessions never restore or persist battery saves
- backend history is queryable for future progression UI
