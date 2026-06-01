# Games Vault Home / Arcade / Auth Wireframe Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Reshape Games Vault around the new wireframe so the product reads as a simple playable arcade/library front door with username/password sign-in, visible active machines, a cleaner games library, and a more explicit admin surface.

**Architecture:** Keep the existing local-profile + `ProfileAuthSession` model and current access service boundary, but reorganize the UX into four clearer surfaces: home/discovery, player session, admin workspace, and profile onboarding/sign-in. Reuse existing server-side session, arcade cabinet, and invite-backed local profile infrastructure instead of introducing ASP.NET Identity or a brand-new auth stack.

**Tech Stack:** ASP.NET Core MVC, Razor views, Entity Framework Core, existing `LocalProfileService` / `CurrentAccessService` / `ProfileInviteService`, Nosebleed session manager, Bootstrap.

---

## Current state to preserve

- Username/password auth already exists in the domain model:
  - `Models/UserProfile.cs`
  - `Profiles/LocalProfileService.cs`
  - `Controllers/ProfilesController.cs`
- The app already has three useful access tiers through `CurrentAccessService`:
  - viewer
  - player
  - admin
- `/` is currently a telemetry/dashboard-heavy home page:
  - `Controllers/HomeController.cs`
  - `Views/Home/Index.cshtml`
- `/Games` is already split into browse vs add/import tabs:
  - `Views/Games/Index.cshtml`
- `/Arcade` already has cabinet creation, preview cards, and join/watch entry:
  - `Views/Arcade/Index.cshtml`
- `/Games/PlayServer/{id}` already has:
  - room creation/join by code
  - room presence panel
  - room chat
  - spectator/player distinction
  - touch controls including arcade controls
- Username/password is already invite-backed for new profile creation; do not regress to PINs.

## Wireframe interpretation

The attached mockup suggests these product shifts:

1. **Home page becomes a product landing page first**
   - top bar with GitHub link, welcome text, and sign-in/join entry
   - large hero/preview region
   - a simple “Active Machines” strip
   - a compact “Games Library” browse area

2. **Admin becomes its own obvious workspace**
   - explicit cards/forms for:
     - add game
     - add arcade machine
     - manage profiles/invites
   - less mixing of admin controls into the player-facing home page

3. **Profile flow becomes visually simpler**
   - clear username/password sign-up and sign-in
   - invite key stays part of registration, not sign-in

4. **Player session page stays centered on the game**
   - large video surface
   - right-side chat
   - player seat labels along the bottom
   - footer row of cabinet/runtime actions like coin, restart, sound, overlay

---

## Delivery strategy

Ship this in four slices:

1. Home IA and shell
2. Profile/sign-in and onboarding simplification
3. Admin workspace extraction
4. Player session layout polish

Do **not** combine all of this into one giant commit.

---

## Task 1: Save the wireframe plan and link it to the current code

**Objective:** Create a durable planning artifact that records the target UX and current implementation anchors.

**Files:**
- Create: `docs/plans/2026-06-01-home-arcade-auth-wireframe-plan.md`

**Step 1: Verify the plan file exists**

Run: `test -f docs/plans/2026-06-01-home-arcade-auth-wireframe-plan.md && echo ok`
Expected: `ok`

**Step 2: Commit the planning doc when implementation starts**

```bash
git add docs/plans/2026-06-01-home-arcade-auth-wireframe-plan.md
git commit -m "docs: add home arcade auth wireframe plan"
```

---

## Task 2: Audit the current view-model boundaries before changing markup

**Objective:** Identify which existing view models can support the wireframe without creating duplicate controller logic.

**Files:**
- Inspect: `Models/ViewModels/HomeIndexViewModel.cs`
- Inspect: `Models/ViewModels/GamesIndexViewModel.cs`
- Inspect: `Models/ViewModels/ServerGamePlayViewModel.cs`
- Inspect: `Models/ViewModels/ProfilesIndexViewModel.cs`
- Inspect: `Models/ViewModels/ProfileEditViewModel.cs`
- Inspect: `Models/ViewModels/ArcadeIndexViewModel.cs`

**Step 1: Read the view models and note missing fields**

Capture whether the wireframe needs new fields for:
- featured/hero active machine
- smaller active machine card summaries
- slimmer home library rows/cards
- dedicated sign-in panel data
- explicit admin shortcuts/form groupings

**Step 2: Prefer extending existing models over creating parallel models**

Rules:
- keep `HomeIndexViewModel` as the home shell model
- keep `Profiles*` view models for auth/onboarding
- keep `ServerGamePlayViewModel` for the player page
- only create new nested partial models if a partial truly has separate reuse value

**Step 3: Document gaps in the first implementation PR description**

Expected outcome:
- a short note of which properties are missing
- no code yet unless a missing field is trivial and clearly needed for the next task

---

## Task 3: Reframe `/` as a simpler home shell

**Objective:** Turn the home page into a clearer landing page with welcome/sign-in, active machines, and library preview while preserving existing data sources.

**Files:**
- Modify: `Controllers/HomeController.cs`
- Modify: `Views/Home/Index.cshtml`
- Modify: `Models/ViewModels/HomeIndexViewModel.cs`
- Test: add or update rendered-markup tests under `tests/games-vault.Tests/`

**Step 1: Write a failing rendered-markup test for the new home sections**

Test for these invariants:
- home page includes a top welcome/sign-in region
- home page includes an `Active machines` section
- home page includes a `Games library` section
- admin-only controls are absent for non-admin viewers

Suggested test file:
- `tests/games-vault.Tests/HomeIndexViewMarkupTests.cs`

**Step 2: Run the test to verify failure**

Run:
```bash
dotnet test -c Release --filter HomeIndexViewMarkupTests
```
Expected: FAIL because the current page is dashboard-heavy and does not match the target section names/shape.

**Step 3: Extend `HomeIndexViewModel` with only the missing shape**

Likely additions:
- `FeaturedSession`
- `HomeActiveMachines`
- `HomeLibraryPreview`
- `CanSignIn`
- `CanJoinOrCreateProfile`
- `AdminQuickLinks`

Do not duplicate the full `Games` page payload on home.

**Step 4: Update `HomeController.Index` to shape the lightweight home data**

Use existing sources:
- active sessions from `NosebleedSessionManager`
- arcade-vs-library classification already present
- current profile / current access service
- a small newest/popular library subset from `Games`

**Step 5: Rewrite `Views/Home/Index.cshtml` around three visual bands**

Band A — top shell:
- GitHub link
- welcome heading
- sign-in / join CTA
- optional featured active machine preview

Band B — active machines:
- horizontal or responsive card list
- each card shows name, mode, and open/watch/join CTA

Band C — games library preview:
- compact search/filter affordance
- a few library cards/chips
- CTA to full `/Games`

**Step 6: Keep richer telemetry below the fold or in secondary cards**

Do not delete telemetry, recent sessions, active profiles, or storage stats if they still matter.
Instead:
- demote them lower on `/`
- or move some into the admin workspace

**Step 7: Re-run the focused test and then the full suite**

Run:
```bash
dotnet test -c Release --filter HomeIndexViewMarkupTests
dotnet test -c Release
```
Expected: PASS

**Step 8: Commit**

```bash
git add Controllers/HomeController.cs Models/ViewModels/HomeIndexViewModel.cs Views/Home/Index.cshtml tests/games-vault.Tests/HomeIndexViewMarkupTests.cs
git commit -m "feat: simplify home page around active machines and library"
```

---

## Task 4: Make sign-in / join a clearer home-page entry point

**Objective:** Reduce the cognitive split between `/` and `/Profiles` so sign-in/join feels like part of the product flow.

**Files:**
- Modify: `Views/Home/Index.cshtml`
- Modify: `Views/Profiles/Index.cshtml`
- Modify: `Views/Profiles/Create.cshtml`
- Modify: `Controllers/ProfilesController.cs` (only if redirect or copy changes are needed)
- Test: `tests/games-vault.Tests/ProfilesViewMarkupTests.cs` or equivalent

**Step 1: Write failing tests for profile entry affordances**

Assert:
- anonymous home shows `Sign in / join`
- profile sign-in uses username + password terminology
- invite key appears on create/join, not on sign-in
- no PIN language appears anywhere in current profile UI

**Step 2: Add a small sign-in panel or CTA on home**

Keep it minimal:
- button(s) to `/Profiles`
- optional inline summary of current signed-in profile when authenticated

Do not duplicate the entire create-account form on the home page unless the markup stays obviously maintainable.

**Step 3: Tighten `/Profiles` information architecture**

Recommended sections:
- current profile / viewer mode status
- sign-in form
- create profile / join with invite CTA
- admin invite management link for admins

**Step 4: Keep security rules unchanged**

Do not let users register without invite codes.
Do not let invite key become part of the sign-in flow.
Do not change password hashing/session logic in this slice.

**Step 5: Re-run tests**

Run:
```bash
dotnet test -c Release --filter Profiles
```

**Step 6: Commit**

```bash
git add Views/Home/Index.cshtml Views/Profiles/Index.cshtml Views/Profiles/Create.cshtml Controllers/ProfilesController.cs tests/games-vault.Tests/
git commit -m "feat: clarify username password sign-in and join flow"
```

---

## Task 5: Extract a more explicit admin workspace

**Objective:** Give admins a dedicated surface closer to the wireframe’s “Admin Page” instead of hiding management across unrelated pages.

**Files:**
- Modify: `Views/Home/Index.cshtml` or create a dedicated admin partial
- Optionally create: `Views/Home/_AdminWorkspace.cshtml`
- Optionally create: `Models/ViewModels/AdminWorkspaceViewModel.cs`
- Modify: `Controllers/HomeController.cs`
- Test: markup tests for admin-only rendering

**Step 1: Write a failing test for admin workspace visibility**

Assert:
- admin sees an `Admin` / `Admin workspace` section
- viewer/player does not
- admin section contains links for games, arcade, profiles/invites, jobs/sources/system files as appropriate

**Step 2: Decide whether the admin workspace lives on `/` or `/Admin`**

Recommendation for now:
- keep a compact admin workspace on `/` for speed
- use existing pages as drill-down destinations

That aligns with the wireframe without forcing a new controller immediately.

**Step 3: Group admin capabilities into three buckets**

Buckets:
- Manage Games
- Manage Arcade Machines
- Profiles / Invites

Secondarily surface:
- sources
- downloads
- jobs
- system files
- system/core mappings

**Step 4: Reuse existing routes instead of inventing new endpoints**

Examples:
- `/Games?openAdd=true`
- `/Arcade`
- `/Profiles`
- `/Profiles/Invites`
- `/Jobs`
- `/Sources`
- `/SystemFiles`
- `/SystemCoreMappings`

**Step 5: Re-run tests and commit**

```bash
dotnet test -c Release --filter HomeIndexViewMarkupTests

git add Controllers/HomeController.cs Views/Home/Index.cshtml Views/Home/_AdminWorkspace.cshtml Models/ViewModels/AdminWorkspaceViewModel.cs tests/games-vault.Tests/
git commit -m "feat: add clearer admin workspace shortcuts"
```

---

## Task 6: Align the Games page with the simplified library preview

**Objective:** Make `/Games` feel like the fuller version of the home-page library strip from the wireframe.

**Files:**
- Modify: `Views/Games/Index.cshtml`
- Modify: `Views/Games/_GamesBank.cshtml`
- Test: `tests/games-vault.Tests/GamesIndexViewMarkupTests.cs`

**Step 1: Write/extend a failing markup test for simpler browse affordances**

Assert:
- games page still has browse/add tabs
- browse section has a visible search/filter control
- game cards remain the primary browse surface
- `Play server-side` remains the dominant CTA

**Step 2: Simplify the browse surface where needed**

Match the wireframe direction:
- lighter search box
- smaller library cards/chips where appropriate
- keep the page “play first”

Do **not** remove batch/admin workflows; just keep them secondary.

**Step 3: Re-run tests and commit**

```bash
dotnet test -c Release --filter GamesIndexViewMarkupTests

git add Views/Games/Index.cshtml Views/Games/_GamesBank.cshtml tests/games-vault.Tests/GamesIndexViewMarkupTests.cs
git commit -m "feat: align games library browse with home preview"
```

---

## Task 7: Refine the Arcade page so it matches the “Active Machines” mental model

**Objective:** Make `/Arcade` read as the full-screen version of the home page’s active machine strip.

**Files:**
- Modify: `Views/Arcade/Index.cshtml`
- Modify: `Models/ViewModels/ArcadeIndexViewModel.cs` if needed
- Test: add arcade markup coverage if absent

**Step 1: Write a failing test for machine-card semantics**

Assert:
- cabinet cards show machine/cabinet name clearly
- watch/join/open CTA is prominent
- admin machine controls are visibly secondary

**Step 2: Adjust card copy and hierarchy**

Priorities:
- machine label first
- game/system second
- running/booting state clear
- watch/join CTA primary
- start/restart/stop/remove admin-only and visually secondary

**Step 3: Re-run tests and commit**

```bash
dotnet test -c Release --filter Arcade

git add Views/Arcade/Index.cshtml tests/games-vault.Tests/
git commit -m "feat: polish arcade machine cards for watch join flow"
```

---

## Task 8: Re-layout the server player page around the wireframe

**Objective:** Preserve the existing room/chat/control features but recompose the page so the game surface is visually dominant and chat sits beside it.

**Files:**
- Modify: `Views/Games/PlayServer.cshtml`
- Modify: supporting JS/CSS only if needed in existing player assets
- Test: rendered-markup test for session layout invariants

**Step 1: Write a failing markup test for the player layout**

Assert:
- main game viewport is present
- room chat panel is present
- room presence / player seats are present
- command row includes sound + overlay controls
- arcade command affordances remain available when relevant

**Step 2: Keep functional behavior, change composition**

Target layout:
- top: room/session title and metadata
- middle left: big game viewport
- middle right: chat/presence stack
- lower area: seat labels / player indicators
- footer row: coin, restart, sound toggle, overlay toggle

**Step 3: Preserve access gating**

Do not regress:
- spectators stay spectators
- viewers can watch but not control
- only players can send gameplay commands
- only signed-in profiles can chat

**Step 4: Re-run tests and targeted manual verification**

Run:
```bash
dotnet test -c Release --filter PlayServer
```

Manual checks:
- anonymous viewer enters and stays spectator
- signed-in player can join control seat
- chat input only appears when `CanChat`
- arcade coin/reset controls still behave correctly

**Step 5: Commit**

```bash
git add Views/Games/PlayServer.cshtml wwwroot/js/nosebleed-player/ tests/games-vault.Tests/
git commit -m "feat: recompose server player around game and chat layout"
```

---

## Task 9: Add profile avatar planning, but do not overbuild it

**Objective:** Handle the wireframe’s avatar field intentionally without dragging the whole project into a media-upload detour.

**Files:**
- Modify later only if chosen: `Models/UserProfile.cs`, profile view models, profile views

**Decision:** defer actual avatar upload implementation unless Joel explicitly wants it in this round.

Recommended MVP:
- keep `AvatarKey` as the future slot
- do not add file upload yet
- if needed, expose a simple avatar preset picker instead of upload

This is a YAGNI boundary.

---

## Task 10: Verification sweep after each slice

**Objective:** Keep every slice shippable.

**Files:**
- Whole repo as affected

**Step 1: Run targeted tests for the touched surface**

Examples:
```bash
dotnet test -c Release --filter HomeIndexViewMarkupTests
dotnet test -c Release --filter GamesIndexViewMarkupTests
dotnet test -c Release --filter LocalProfileServiceTests
dotnet test -c Release --filter SpectatorAccessTests
```

**Step 2: Run the full suite before pushing**

```bash
dotnet test -c Release
```

**Step 3: Manually verify the core journeys**

Journeys:
- anonymous visitor lands on `/`, sees active machines and sign-in/join CTA
- anonymous visitor can watch active machine/session
- invited user creates profile with username/password and is signed in
- signed-in player can start/join a library session
- admin can reach add/import and arcade management from the new workspace
- spectator does not get silently promoted into a player seat

---

## Recommended implementation order

1. Home page shell and markup tests
2. Profile entry/sign-in copy and flow polish
3. Admin workspace extraction
4. Arcade card polish
5. Player session layout polish
6. Optional avatar follow-up only if still desired

---

## Non-goals for this round

- ASP.NET Identity migration
- OAuth / Google sign-in
- passkey resurrection
- profile avatar uploads/storage pipeline
- changing invite security model
- reworking gameplay session backend behavior beyond layout/access regressions

---

## Acceptance criteria

- Home page clearly communicates:
  - welcome
  - sign in / join
  - active machines
  - games library
- Username/password remains the canonical local auth path.
- Invite key is required for registration but not sign-in.
- Admin controls are easier to find without exposing them to viewers/players.
- Arcade and library entry points feel product-first, not admin-first.
- Player session page is visually centered on the game while preserving room/chat/access features.
- Existing spectator authorization fixes remain intact.

---

## Execution handoff

Plan complete and saved. Ready to execute in slices.

Recommended first implementation PR:
1. home shell rewrite
2. profile/sign-in CTA cleanup
3. markup tests for both
