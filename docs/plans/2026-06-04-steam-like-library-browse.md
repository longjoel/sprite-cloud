# Steam-Like Library Browse Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Make the Games browse library feel inviting and useful, with working search/filter/group/sort modes like a small Steam library.

**Architecture:** Keep `/Games` and `/Games/Bank` as the primary server-rendered entry points, then progressively enhance the browse pane with AJAX updates already present in `Views/Games/Index.cshtml`. Add a typed query object/view model so search, filters, grouping, sorting, and pagination use the same code path in the full page and partial bank endpoint. Compute play stats from existing play-room/session data first; add denormalized stats later only if live queries become slow.

**Tech Stack:** ASP.NET Core MVC, Razor views, EF Core/SQLite, Bootstrap, vanilla JavaScript, xUnit markup/controller tests.

---

## Current State

- `Controllers/GamesController.cs` exposes:
  - `Index(...)` for full Games page rendering.
  - `Bank(string? q, int page = 1, int pageSize = 25, int? batchId = null, ...)` for AJAX partial updates.
  - `BuildGamesBankAsync(...)` does current filtering and always sorts by `CreatedUtc DESC`.
- `Views/Games/Index.cshtml` has a basic search box and page-size selector with JS that fetches `/Games/Bank`.
- `Views/Games/_GamesBank.cshtml` renders card rows and pagination for the current page.
- `Models/ViewModels/GamesIndexViewModel.cs` and `GamesBankViewModel` hold the current list, query, page size, and missing BIOS/system-file state.
- Existing data already includes useful browse signals:
  - `Game.SystemName`
  - `Game.NumberOfPlayers` / equivalent metadata if present on the model
  - `GamePlayRoom` active room/session state
  - profile/global play stats exposed on the home/profile pages
- The near-term UX should stay server-rendered and reliable; do not introduce a SPA framework.

---

## Acceptance Criteria

- Browse library has a more inviting hero/header with clear copy, quick stat chips, and visually obvious search/filter controls.
- Search works for game name, system, file name, and CRC without breaking pagination.
- Filters support at minimum:
  - System
  - Number of players
  - Currently being played
- Sort/group controls support at minimum:
  - Alphabetical A-Z / Z-A
  - Recently added
  - Recently played
  - Most played all time
  - Most played this week
  - Number of players
  - System
- Grouping can show section headers for:
  - System
  - Alphabetical initial
  - Number of players
  - Currently playing
- `/Games` and `/Games/Bank` accept the same query parameters and produce consistent results.
- Browser back/forward and shared URLs preserve search/filter/sort/group/page state.
- Tests cover query parsing, view markup, and at least representative sort/filter behavior.

---

### Task 1: Add typed browse query and enum models

**Objective:** Replace loose `q/page/pageSize` plumbing with a single typed object that can carry future filters safely.

**Files:**
- Create: `Models/ViewModels/GamesLibraryBrowseQuery.cs`
- Modify: `Models/ViewModels/GamesIndexViewModel.cs`
- Modify: `Models/ViewModels/GamesBankViewModel.cs`
- Test: `tests/games-vault.Tests/GamesLibraryBrowseQueryTests.cs`

**Implementation notes:**

Create enums:

```csharp
public enum GamesLibrarySort
{
    RecentlyAdded,
    AlphabeticalAsc,
    AlphabeticalDesc,
    RecentlyPlayed,
    MostPlayedAllTime,
    MostPlayedThisWeek,
    NumberOfPlayers,
    System
}

public enum GamesLibraryGroup
{
    None,
    System,
    Alphabetical,
    NumberOfPlayers,
    CurrentlyPlaying
}
```

Create query model:

```csharp
public sealed class GamesLibraryBrowseQuery
{
    public string? Q { get; init; }
    public string? System { get; init; }
    public int? Players { get; init; }
    public bool PlayingNow { get; init; }
    public GamesLibrarySort Sort { get; init; } = GamesLibrarySort.RecentlyAdded;
    public GamesLibraryGroup Group { get; init; } = GamesLibraryGroup.None;
    public int Page { get; init; } = 1;
    public int PageSize { get; init; } = 25;
}
```

Add `Browse` properties to both page/bank view models while keeping existing `Query`, `Page`, and `PageSize` until the views are migrated.

**Verification:**

Run:

```bash
dotnet test tests/games-vault.Tests/games-vault.Tests.csproj --filter GamesLibraryBrowseQueryTests
```

---

### Task 2: Update controller signatures to use the browse query

**Objective:** Make full-page and AJAX bank endpoints share one browse pipeline.

**Files:**
- Modify: `Controllers/GamesController.cs`
- Test: existing `SpectatorAccessTests.cs` or new `GamesControllerBrowseTests.cs`

**Steps:**

1. Change `Index` to bind `GamesLibraryBrowseQuery browse` from query string while preserving existing optional import/session parameters.
2. Change `Bank` to bind the same query model.
3. Update `BuildGamesBankAsync(GamesLibraryBrowseQuery browse, int? batchId, CancellationToken)`.
4. Normalize `Page`, `PageSize`, and blank strings inside the builder.
5. Keep old query-string names (`q`, `page`, `pageSize`) so existing links still work.

**Verification:**

Run:

```bash
dotnet test tests/games-vault.Tests/games-vault.Tests.csproj --filter GamesController
```

---

### Task 3: Preserve and harden search

**Objective:** Make existing search explicit and test-backed before adding more filters.

**Files:**
- Modify: `Controllers/GamesController.cs`
- Test: `tests/games-vault.Tests/GamesLibrarySearchTests.cs`

**Expected behavior:**

- `q=sonic` matches `Game.Name`.
- `q=genesis` matches `Game.SystemName`.
- `q=.bin` matches `GameFile.Name`.
- `q=abcd1234` matches `GameFile.Crc32`.
- Search is case-insensitive.
- Changing search resets page to `1` from JS.

**Verification:**

Run:

```bash
dotnet test tests/games-vault.Tests/games-vault.Tests.csproj --filter GamesLibrarySearchTests
```

---

### Task 4: Add filter option data to the bank/page view models

**Objective:** Populate system and player-count options so the view can render real filters instead of hard-coded choices.

**Files:**
- Modify: `Models/ViewModels/GamesIndexViewModel.cs`
- Modify: `Models/ViewModels/GamesBankViewModel.cs`
- Modify: `Controllers/GamesController.cs`
- Test: `tests/games-vault.Tests/GamesLibraryFilterOptionTests.cs`

**Implementation notes:**

Add lightweight option records:

```csharp
public sealed record GamesLibrarySystemOption(string Name, int Count);
public sealed record GamesLibraryPlayerCountOption(int Players, int Count);
```

Compute from all games matching the search text, before applying the specific filter for that facet. This lets the UI show available systems/player counts after a search.

**Verification:**

Run:

```bash
dotnet test tests/games-vault.Tests/games-vault.Tests.csproj --filter GamesLibraryFilterOptionTests
```

---

### Task 5: Implement system/player/currently-playing filters

**Objective:** Add the first real faceted filters.

**Files:**
- Modify: `Controllers/GamesController.cs`
- Test: `tests/games-vault.Tests/GamesLibraryFilterTests.cs`

**Rules:**

- `system=<systemName>` filters exact case-insensitive `Game.SystemName`.
- `players=2` filters games whose metadata says two players.
- `playingNow=true` filters games with an active `GamePlayRoom`/Nosebleed session or active arcade cabinet tied to the game.
- Filters combine with search using AND semantics.

**Verification:**

Run:

```bash
dotnet test tests/games-vault.Tests/games-vault.Tests.csproj --filter GamesLibraryFilterTests
```

---

### Task 6: Add sort modes backed by play stats

**Objective:** Support Steam-like sorting without denormalizing yet.

**Files:**
- Modify: `Controllers/GamesController.cs`
- Test: `tests/games-vault.Tests/GamesLibrarySortTests.cs`

**Sort behavior:**

- `RecentlyAdded`: `Game.CreatedUtc DESC`.
- `AlphabeticalAsc`: `Game.Name ASC`.
- `AlphabeticalDesc`: `Game.Name DESC`.
- `System`: `Game.SystemName ASC`, then `Game.Name ASC`.
- `NumberOfPlayers`: player count DESC, then `Game.Name ASC`.
- `RecentlyPlayed`: last completed/active session timestamp DESC, fallback to `CreatedUtc DESC`.
- `MostPlayedAllTime`: total sessions or total duration DESC, then `Game.Name ASC`.
- `MostPlayedThisWeek`: same stat, scoped to `StartedUtc >= now - 7 days`.

**Implementation note:** Start with session count if duration fields are inconsistent; document the choice in code comments and tests.

**Verification:**

Run:

```bash
dotnet test tests/games-vault.Tests/games-vault.Tests.csproj --filter GamesLibrarySortTests
```

---

### Task 7: Add grouped bank rows

**Objective:** Let the same card list render optional group headers.

**Files:**
- Modify: `Models/ViewModels/GamesBankViewModel.cs`
- Modify: `Views/Games/_GamesBank.cshtml`
- Test: `tests/games-vault.Tests/GamesIndexViewMarkupTests.cs`

**Implementation notes:**

Add:

```csharp
public sealed record GamesLibraryGroupSection(string Label, IReadOnlyList<Game> Games);
```

The bank model can expose `Sections`; when `Group == None`, return one unlabeled section or use the existing flat render path.

Group labels:

- System: actual system name or `Unknown system`.
- Alphabetical: `A`, `B`, `#`.
- Number of players: `1 player`, `2 players`, `Unknown players`.
- Currently playing: `Playing now`, `Not currently playing`.

**Verification:**

Run:

```bash
dotnet test tests/games-vault.Tests/games-vault.Tests.csproj --filter GamesIndexViewMarkupTests
```

---

### Task 8: Redesign browse controls and hero copy

**Objective:** Make Browse Library feel inviting and obvious.

**Files:**
- Modify: `Views/Games/Index.cshtml`
- Modify: `wwwroot/css/site.css`
- Test: `tests/games-vault.Tests/GamesIndexViewMarkupTests.cs`

**UI shape:**

- Hero title: `Browse your library`.
- Subtitle: emphasize instant play, systems, recently played, and shared arcade sessions.
- Add stat chips: total games, systems count, active now count, recent this week count.
- Add a prominent search field with placeholder: `Search games, systems, files, CRC…`.
- Add filter row:
  - System dropdown
  - Players dropdown
  - Sort dropdown
  - Group dropdown
  - Playing now toggle
  - Clear filters button

**Verification:**

Run:

```bash
dotnet test tests/games-vault.Tests/games-vault.Tests.csproj --filter GamesIndexViewMarkupTests
```

Then manually verify `/Games` in browser or with curl for the expected markup.

---

### Task 9: Update AJAX browse JavaScript

**Objective:** Make all controls update the bank partial and URL state without page reload.

**Files:**
- Modify: `Views/Games/Index.cshtml`
- Test: `tests/games-vault.Tests/GamesIndexViewMarkupTests.cs`

**Behavior:**

- Any change to search/filter/sort/group resets `page=1`.
- Page-size changes reset `page=1`.
- Bank fetch sends all browse query parameters.
- `history.replaceState` updates the URL so copying the page preserves current browse state.
- Full form submit still works without JS.

**Verification:**

Run:

```bash
dotnet test tests/games-vault.Tests/games-vault.Tests.csproj --filter GamesIndexViewMarkupTests
```

Manual checks:

```bash
curl -fsS 'http://127.0.0.1:8090/Games?q=sonic&sort=AlphabeticalAsc&group=System' >/dev/null
curl -fsS 'http://127.0.0.1:8090/Games/Bank?q=sonic&sort=AlphabeticalAsc&group=System' >/dev/null
```

---

### Task 10: Add empty states for filtered library views

**Objective:** Make no-result cases helpful instead of dead ends.

**Files:**
- Modify: `Views/Games/_GamesBank.cshtml`
- Test: `tests/games-vault.Tests/GamesIndexViewMarkupTests.cs`

**Empty states:**

- No games at all: invite adding/importing games.
- Search no matches: suggest clearing search.
- Filters no matches: show active filters and a clear-filters button.
- Playing now no matches: link to Arcade and normal library.

**Verification:**

Run:

```bash
dotnet test tests/games-vault.Tests/games-vault.Tests.csproj --filter GamesIndexViewMarkupTests
```

---

### Task 11: Performance check and indexes

**Objective:** Keep browse responsive as the library grows.

**Files:**
- Modify: `Data/AppDbContext.cs` or migrations if indexes are needed
- Test: migration/model snapshot tests if present

**Checks:**

- Inspect generated SQL for sort/filter paths during development.
- Add indexes only where measured useful:
  - `Games.SystemName`
  - `Games.Name`
  - `GamePlayRooms.GameId`, `StartedUtc`, `Status`
  - `ArcadeCabinets.GameId`, `RuntimeSessionId`
- Avoid adding full-text search until substring search becomes a real bottleneck.

**Verification:**

Run full tests and manually load `/Games` with a realistic library size.

---

### Task 12: Final verification and deploy

**Objective:** Prove the completed browse work locally and on dev before prod.

**Commands:**

```bash
git diff --check
dotnet test tests/games-vault.Tests/games-vault.Tests.csproj
node --test tests/js/*.test.js
dotnet publish games-vault.csproj -c Release -o /tmp/games-vault-dev-publish
```

Dev verification:

```bash
curl -fsS 'http://127.0.0.1:8090/Games' >/dev/null
curl -fsS 'http://127.0.0.1:8090/Games/Bank?q=a&sort=AlphabeticalAsc&group=System' >/dev/null
```

Prod verification should use the existing `scripts/deploy-prod-from-main.sh` after the branch is merged to `main` and dev testing looks good.

---

## Suggested Commit Slices

1. `refactor: add typed games library browse query`
2. `fix: harden games library search`
3. `feat: add games library filters`
4. `feat: add games library sort modes`
5. `feat: group games library results`
6. `feat: refresh games browse UI`
7. `test: cover games library browse behavior`

## Non-goals For First Pass

- No SPA rewrite.
- No full-text search engine yet.
- No cover-art scraping/import changes.
- No recommendation engine.
- No per-user hidden/favorite shelves until the base browse model is stable.
