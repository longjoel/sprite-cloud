# Arcade Launch Screen Game Picker Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Make adding games to the Arcade launch screen scale beyond a giant dropdown by replacing the cabinet add form with a searchable, filterable library picker optimized for large ROM collections.

**Architecture:** Keep the Arcade page as the primary launch surface, but move game selection into a dedicated browse/pick experience. The server should expose a small Arcade-scoped game picker endpoint backed by the same normalized browse concepts used on the Games library page: search, system filter, player-count filter, sort, active/metadata badges, and pagination. The UI should let an admin search/browse, preview a candidate, enter an optional cabinet label, and add the cabinet without scrolling through hundreds or thousands of `<option>` rows.

**Tech Stack:** ASP.NET Core MVC/Razor, EF Core, Bootstrap modal/offcanvas, existing Games Vault view-model conventions, xUnit markup/controller tests.

---

## Current State

- `Controllers/ArcadeController.cs:24-90` builds the Arcade launch screen.
- `ArcadeController.Index` currently loads `GameOptions` with:
  - stored/linked ROMs only
  - ordered by game name
  - hard capped at `.Take(300)`
- `Views/Arcade/Index.cshtml:36-67` renders an **Add a free-play cabinet** card with a plain `<select id="gameId">` listing `Model.GameOptions`.
- `ArcadeController.AddCabinet(int gameId, string? displayName, ...)` already creates a cabinet once the game id is known.
- `Models/ViewModels/ArcadeIndexViewModel.cs` currently has `GameOptions`, but no query/filter/pagination data.
- The Games page now has a richer browse model (`GamesLibraryBrowseQuery`) and UX that can be mirrored conceptually, but the Arcade picker should remain cabinet-focused and lighter than the full Games page.

## Product Direction

The Arcade launch screen should feel like an arcade floor manager, not a form with a massive dropdown.

Recommended shape:

1. Replace the always-visible dropdown with an **Add cabinet** call-to-action.
2. Open a **game picker modal/offcanvas**.
3. Inside the picker:
   - search box with debounce
   - system filter
   - player-count filter
   - sort select
   - paginated card/list results
   - selected game preview
   - optional cabinet label
   - primary `Add cabinet` submit
4. Preserve simple POST semantics for final creation: selected `gameId` + optional `displayName` still posts to `Arcade/AddCabinet`.
5. Add an optional shortcut from Games library cards later: `Add to arcade` for admin users.

---

## Acceptance Criteria

- The Arcade page no longer renders a huge `<select>` of every playable game.
- Admins can search for a game by name, system, file name, or CRC before adding it to the arcade.
- Admins can filter candidates by system and player count.
- The picker works for libraries larger than 300 games; no arbitrary hard cap hides games.
- Results are paginated or infinite-load bounded so the page stays fast.
- Picking a game fills a selected-game panel and enables `Add cabinet`.
- Cabinet label defaults to the selected game name but remains editable.
- Non-admin users do not see management controls or picker endpoints.
- Existing cabinet start/stop/restart/remove behavior remains unchanged.
- Tests cover markup removal of the old dropdown and the presence of the scalable picker affordances.

---

## Task 1: Introduce Arcade Picker Query/View Models

**Objective:** Add typed models for the Arcade game picker instead of passing a giant `GameOptions` list through `ArcadeIndexViewModel`.

**Files:**
- Create: `Models/ViewModels/ArcadeGamePickerQuery.cs`
- Modify: `Models/ViewModels/ArcadeIndexViewModel.cs`
- Test: `tests/games-vault.Tests/ArcadeGamePickerQueryTests.cs`

**Implementation notes:**
- Model fields:
  - `Q`
  - `System`
  - `Players`
  - `Sort`
  - `Page`
  - `PageSize`
- Sort enum should start small:
  - `AlphabeticalAsc`
  - `RecentlyAdded`
  - `System`
  - `NumberOfPlayers`
- Normalize method should trim strings and clamp page/page size.
- Add result row model:
  - `Id`
  - `Name`
  - `SystemName`
  - `NumberOfPlayers`
  - `FileCount`
  - `HasStoredOrLinkedFile`
  - optional `AlreadyCabinetCount`

**Verification:**

```bash
dotnet test tests/games-vault.Tests/games-vault.Tests.csproj --filter ArcadeGamePickerQueryTests
```

Expected: tests pass.

---

## Task 2: Add Arcade Game Picker Endpoint

**Objective:** Add a server endpoint that returns filtered/paginated picker results without loading the entire library into the Arcade page.

**Files:**
- Modify: `Controllers/ArcadeController.cs`
- Create or modify partial: `Views/Arcade/_GamePickerResults.cshtml`
- Test: `tests/games-vault.Tests/ArcadeControllerTests.cs`

**Endpoint shape:**

```csharp
[HttpGet]
public async Task<IActionResult> GamePicker([FromQuery] ArcadeGamePickerQuery query, CancellationToken cancellationToken)
```

**Behavior:**
- Require `CanManageLibraryAsync`; return `Forbid()` when false.
- Only include games with at least one stored or linked ROM file.
- Search by:
  - game name
  - system name
  - file name
  - CRC32
- Filter by system and player count.
- Return a partial for AJAX requests.
- Include total count/page count in the picker model.

**Verification:**

```bash
dotnet test tests/games-vault.Tests/games-vault.Tests.csproj --filter ArcadeControllerTests
```

Expected: existing Arcade tests plus new picker tests pass.

---

## Task 3: Replace Dropdown Form With Picker Modal/Offcanvas

**Objective:** Remove the large game dropdown from `Views/Arcade/Index.cshtml` and replace it with a scalable picker UI.

**Files:**
- Modify: `Views/Arcade/Index.cshtml`
- Create: `Views/Arcade/_GamePickerResults.cshtml`
- Modify: `wwwroot/css/site.css`
- Test: `tests/games-vault.Tests/ArcadeIndexViewMarkupTests.cs`

**UI shape:**
- Existing card becomes a compact CTA:
  - title: `Add cabinet`
  - copy: `Search your library and pin a game to the arcade floor.`
  - button: `Choose game`
- Modal/offcanvas contains:
  - search input
  - system select
  - players select
  - sort select
  - results panel
  - selected-game summary panel
  - cabinet label input
  - `Add cabinet` submit button

**Important:**
- The final create form should still submit `gameId` and `displayName` to `AddCabinet`.
- Disable submit until a result is selected.
- Keep no-JS fallback acceptable: a direct `/Arcade/GamePicker` page/partial can still render searchable results, or the modal can submit filters with normal GET.

**Verification:**

```bash
dotnet test tests/games-vault.Tests/games-vault.Tests.csproj --filter ArcadeIndexViewMarkupTests
```

Expected checks:
- no `<select id="gameId">` on the main Arcade page
- `Choose game` CTA exists
- picker modal/offcanvas exists
- search/filter controls exist
- hidden `gameId` input exists in add form

---

## Task 4: Add Picker JavaScript

**Objective:** Make the picker fast and pleasant without a full page reload for every filter/search change.

**Files:**
- Create: `wwwroot/js/arcade-game-picker.js`
- Modify: `Views/Arcade/Index.cshtml`
- Test: `tests/js/arcade-game-picker.test.js` if current JS test harness can cover pure helpers; otherwise use markup/source tests.

**Behavior:**
- Debounce search input.
- Fetch `/Arcade/GamePicker?...` into the results container.
- Preserve query params inside modal state.
- Clicking a result:
  - stores selected game id in hidden input
  - updates selected-game panel
  - defaults cabinet label to game name if label is blank
  - enables `Add cabinet`
- Pagination links load inside the modal instead of navigating the whole page.
- On fetch failure, show an inline warning and leave existing results intact.

**Verification:**

```bash
node --test tests/js/*.test.js
```

Expected: existing JS tests and any new helper tests pass.

---

## Task 5: Improve Arcade Launch Screen Context

**Objective:** Use the freed-up space on the Arcade page for launch-screen information instead of form chrome.

**Files:**
- Modify: `Views/Arcade/Index.cshtml`
- Modify: `Models/ViewModels/ArcadeIndexViewModel.cs`
- Modify: `Controllers/ArcadeController.cs`

**Enhancements:**
- Add header chips:
  - cabinet count
  - running count
  - systems represented
- Add an empty-state card that points admins to `Choose game`.
- On cabinet cards, show whether the game already has multiple cabinets.
- Keep action labels simple; no save controls on arcade surfaces.

**Verification:**

```bash
dotnet test tests/games-vault.Tests/games-vault.Tests.csproj --filter ArcadeIndexViewMarkupTests
```

Expected: markup tests pass.

---

## Task 6: Full Verification, Commit, Deploy to VAULT Dev

**Objective:** Prove the new picker works and ship it to VAULT dev.

**Commands:**

```bash
dotnet test tests/games-vault.Tests/games-vault.Tests.csproj
node --test tests/js/*.test.js
git diff --check
rm -rf /tmp/games-vault-dev-publish
dotnet publish games-vault.csproj -c Release -o /tmp/games-vault-dev-publish
```

Deploy to dev using the existing local `/opt/games-vault` flow, then verify:

```bash
systemctl is-active games-vault
curl -fsS -o /tmp/gv-arcade.html http://127.0.0.1:8090/Arcade
curl -fsS -o /tmp/gv-arcade-picker.html 'http://127.0.0.1:8090/Arcade/GamePicker?q=mario&pageSize=10'
```

Expected:
- service active
- Arcade page contains picker CTA
- picker endpoint returns result markup without server errors

Commit message:

```bash
git add Controllers/ArcadeController.cs Models/ViewModels/ArcadeIndexViewModel.cs Models/ViewModels/ArcadeGamePickerQuery.cs Views/Arcade/Index.cshtml Views/Arcade/_GamePickerResults.cshtml wwwroot/js/arcade-game-picker.js wwwroot/css/site.css tests/games-vault.Tests/Arcade* tests/js/arcade-game-picker.test.js
git commit -m "Improve arcade game picker"
```

---

## Follow-up Ideas

These are intentionally not part of the first slice:

- Add `Add to arcade` action directly on Games library cards for admins.
- Save favorite arcade candidates or recently-added-to-arcade games.
- Add cabinet templates for multi-cabinet setups.
- Bulk-create cabinets from filtered results.
- Artwork/box-art picker cards once artwork metadata exists.
