# Single Administrative Backend Page Implementation Plan

> **For Hermes:** Implement directly in small slices; keep public play/watch/login surfaces uncluttered.

**Goal:** Provide one `/Admin` backend landing page for anything that is not playing games, watching games, or logging in.

**Architecture:** Add an admin-only `AdminController` and `Views/Admin/Index.cshtml` as the backend hub. The top nav should expose one `Admin` link instead of a dropdown of backend destinations. Existing specialized management pages remain intact for CRUD workflows, but they are reached through the backend page.

**Tech Stack:** ASP.NET Core MVC, Razor, EF Core, existing `AdminOnlyFilter`, existing Nosebleed session/process services.

---

### Task 1: Add backend admin page model

**Objective:** Define a view model with quick counts and Nosebleed process survey rows.

**Files:**
- Create: `Models/ViewModels/AdminIndexViewModel.cs`

**Verification:** Project builds.

### Task 2: Add admin controller

**Objective:** Add an admin-only `/Admin` page that aggregates library, source, operation, profile, and runtime state.

**Files:**
- Create: `Controllers/AdminController.cs`

**Verification:** `/Admin` redirects non-admins via `AdminOnlyFilter`; admin users get HTTP 200.

### Task 3: Add admin Razor page

**Objective:** Render backend cards for library management, imports/sources, jobs/downloads, profiles/invites, core/system files, and Nosebleed runtime survey/termination.

**Files:**
- Create: `Views/Admin/Index.cshtml`

**Verification:** Markup contains only backend/admin destinations and terminate actions for runtime rows.

### Task 4: Simplify global nav

**Objective:** Replace the admin dropdown with a single `Admin` nav link to `/Admin`.

**Files:**
- Modify: `Views/Shared/_Layout.cshtml`
- Modify tests: `tests/games-vault.Tests/LayoutNavigationMarkupTests.cs`

**Verification:** Home, Arcade, Games, Sign in remain top-level. Backend links disappear from top nav and appear on `/Admin`.

### Task 5: Tests and deployment

**Objective:** Add source-level tests for the admin page and run full verification.

**Commands:**
- `dotnet test`
- `dotnet publish games-vault.csproj -c Release -o /tmp/games-vault-dev-publish`
- deploy to VAULT dev and verify `/Admin`, `/`, and `/Arcade` return expected statuses.
