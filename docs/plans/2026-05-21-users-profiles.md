# Users and Profiles Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Add local arcade-style profiles to Games Vault so play sessions, dashboard stats, saves, and future high-score/memory stats can be attributed to a selected player, using browser passkeys as the MVP registration/sign-in mechanism instead of passwords.

**Architecture:** Start with local profiles plus WebAuthn/passkeys, not email/password auth. Store profiles and passkey credentials in SQLite, use WebAuthn challenge/response for registration and sign-in, persist the authenticated selected profile id in an HTTP-only cookie/session, validate it against the database on each request, attach new play sessions to the selected profile, and add profile-aware dashboard slices while preserving global/all-player views. Keep the schema ready for later per-profile saves, achievements, high scores, play history, and Nosebleed memory-derived stats.

**Tech Stack:** ASP.NET Core MVC, EF Core/SQLite migrations, Razor views, Bootstrap, browser WebAuthn/passkey APIs, a server-side FIDO2/WebAuthn validation library, xUnit, existing `GamePlayTelemetryService`, existing `GamePlaySession` dashboard pipeline.

---

## Current State

- The app is an ASP.NET Core MVC app using `AppDbContext` and EF Core migrations.
- Existing database entities include `Game`, `GameFile`, `GamePlayerFile`, and `GamePlaySession`.
- `GamePlaySession` currently stores:
  - `GameId`
  - optional `GameFileId`
  - `Mode`
  - optional `ExternalSessionId`
  - `StartedUtc`
  - optional `EndedUtc`
  - `DurationSeconds`
  - optional `EndReason`
- `GamePlayTelemetryService` starts, finishes, reconciles, touches, and aggregates play sessions globally.
- `HomeController.Index` already builds a global dashboard with total play time, play session count, top-played games, active Nosebleed sessions, live preview tokens, and orphan process controls.
- `GamesController.PlayServer` starts Nosebleed sessions and calls `gamePlayTelemetry.StartAsync(game.Id, file.Id, "nosebleed", session.Id, cancellationToken)`.
- There is no user/profile model, no profile picker, and no profile attribution in play telemetry yet.
- We have uncommitted work from the dashboard/session-manager/mobile-control slice. Do not rewrite or discard it.

## Product Decisions

- Build **local arcade profiles with browser passkeys first**, not email/password auth.
- A profile is a player identity for a household/LAN arcade cabinet style setup.
- A registered profile is created by choosing a display name/color and registering a browser/platform passkey. The passkey may be device-local or portable/synced depending on the user's platform/account/password manager.
- Keep passkeys optional only for emergency/admin bootstrap if needed; normal player registration should produce a passkey-backed profile.
- Plan the UI around three access views from the beginning:
  1. **Unregistered viewer** — can see games currently in progress and join/watch permitted public session surfaces, but cannot start games or manage the library.
  2. **Registered profile/player** — has a local profile, can play games, join games in progress, and accumulates play history/stats/saves.
  3. **Admin** — can add/import/edit/delete games, manage sources/system files/jobs/downloads, manage profiles, and kill/clean up Nosebleed sessions.
- Profiles should be easy to create and switch from the navbar/home screen.
- Anonymous/no-profile play should still work for viewing active sessions, but starting gameplay should require choosing or creating a profile once access gating lands.
- Dashboard cards should support both selected-profile stats and global/all-player stats.
- This should lay the foundation for:
  - per-profile play history
  - per-profile saves
  - high scores / derived stats
  - memory-monitoring snapshots per game/profile/session
  - later PIN/password/auth fallback if needed

## Acceptance Criteria

- A user can create a local profile with a display name and register a browser passkey.
- A returning user can sign in/select their profile using the passkey flow.
- A user can select/switch the current profile from the UI after passkey verification.
- The selected authenticated profile persists across browser sessions using a cookie/session.
- Starting a web/Nosebleed play session records `ProfileId` when a profile is selected.
- Existing historical sessions remain valid with `ProfileId = null`.
- Home dashboard shows the current profile and profile-scoped stats when selected.
- Home dashboard still shows global stats when no profile is selected.
- An unregistered/no-profile visitor can see active games in progress but does not see library-management controls.
- A registered profile/player can start games and join games in progress.
- Admin-only surfaces are separated from player/viewer surfaces: add/import/edit/delete games, sources, system files, jobs, downloads, and destructive session/process controls.
- A Profiles page lists profiles with basic rollups: total play time, session count, last played.
- Profile details page shows recent play sessions and top games for that profile.
- Tests cover profile creation validation, profile selection persistence, telemetry attribution, and access-mode visibility rules.
- `dotnet test --no-restore` and `dotnet build -c Release --no-restore` pass.

---

## Phase 1: Local Profile Data Model

### Task 1: Add `UserProfile` entity

**Objective:** Create the core local profile model.

**Files:**
- Create: `Models/UserProfile.cs`
- Modify: `Data/AppDbContext.cs`
- Test: `tests/games-vault.Tests/ProfileModelTests.cs`

**Implementation notes:**

Create `Models/UserProfile.cs`:

```csharp
using System.ComponentModel.DataAnnotations;

namespace games_vault.Models;

public sealed class UserProfile
{
    public int Id { get; set; }

    [Required]
    [StringLength(80)]
    public string DisplayName { get; set; } = "";

    [StringLength(32)]
    public string? AvatarKey { get; set; }

    [StringLength(20)]
    public string Color { get; set; } = "#0d6efd";

    public DateTime CreatedUtc { get; set; } = DateTime.UtcNow;

    public DateTime UpdatedUtc { get; set; } = DateTime.UtcNow;

    public bool IsArchived { get; set; }
}
```

Modify `Data/AppDbContext.cs`:

```csharp
public DbSet<UserProfile> UserProfiles => Set<UserProfile>();
```

Add model configuration:

```csharp
modelBuilder.Entity<UserProfile>(entity =>
{
    entity.Property(x => x.DisplayName).HasMaxLength(80);
    entity.Property(x => x.AvatarKey).HasMaxLength(32);
    entity.Property(x => x.Color).HasMaxLength(20);
    entity.HasIndex(x => x.DisplayName);
});
```

**Verification:**

Run:

```bash
dotnet test --no-restore
```

Expected: existing tests still pass.

### Task 1A: Add passkey credential entity

**Objective:** Store WebAuthn/passkey public-key credentials for profile registration and sign-in.

**Files:**
- Create: `Models/UserProfilePasskey.cs`
- Modify: `Models/UserProfile.cs`
- Modify: `Data/AppDbContext.cs`
- Test: `tests/games-vault.Tests/ProfilePasskeyModelTests.cs`

**Implementation notes:**

Create a separate credential table so a profile can have multiple passkeys later:

```csharp
using System.ComponentModel.DataAnnotations;

namespace games_vault.Models;

public sealed class UserProfilePasskey
{
    public int Id { get; set; }

    public int ProfileId { get; set; }

    public UserProfile Profile { get; set; } = null!;

    [Required]
    [StringLength(512)]
    public string CredentialIdBase64Url { get; set; } = "";

    [Required]
    public byte[] PublicKey { get; set; } = [];

    [Required]
    [StringLength(128)]
    public string UserHandleBase64Url { get; set; } = "";

    public uint SignatureCounter { get; set; }

    [StringLength(200)]
    public string? DeviceName { get; set; }

    public DateTime CreatedUtc { get; set; } = DateTime.UtcNow;

    public DateTime? LastUsedUtc { get; set; }
}
```

Add to `UserProfile`:

```csharp
[StringLength(128)]
public string PasskeyUserHandleBase64Url { get; set; } = "";
```

Add to `AppDbContext`:

```csharp
public DbSet<UserProfilePasskey> UserProfilePasskeys => Set<UserProfilePasskey>();
```

Configure:

```csharp
modelBuilder.Entity<UserProfile>(entity =>
{
    entity.Property(x => x.PasskeyUserHandleBase64Url).HasMaxLength(128);
    entity.HasIndex(x => x.PasskeyUserHandleBase64Url).IsUnique();
});

modelBuilder.Entity<UserProfilePasskey>(entity =>
{
    entity.Property(x => x.CredentialIdBase64Url).HasMaxLength(512);
    entity.Property(x => x.UserHandleBase64Url).HasMaxLength(128);
    entity.Property(x => x.DeviceName).HasMaxLength(200);
    entity.HasIndex(x => x.CredentialIdBase64Url).IsUnique();
    entity.HasIndex(x => x.UserHandleBase64Url);

    entity.HasOne(x => x.Profile)
        .WithMany()
        .HasForeignKey(x => x.ProfileId)
        .OnDelete(DeleteBehavior.Cascade);
});
```

**Verification:**

Run:

```bash
dotnet test --no-restore --filter ProfilePasskeyModelTests
```

Expected: credential uniqueness, profile cascade, and user-handle constraints work.

### Task 2: Attach optional profile to `GamePlaySession`

**Objective:** Make play telemetry attributable to a profile while keeping old anonymous sessions valid.

**Files:**
- Modify: `Models/GamePlaySession.cs`
- Modify: `Data/AppDbContext.cs`
- Test: `tests/games-vault.Tests/GamePlayTelemetryServiceTests.cs`

**Implementation notes:**

Add to `GamePlaySession`:

```csharp
public int? ProfileId { get; set; }

public UserProfile? Profile { get; set; }
```

Add EF relationship in `AppDbContext` inside `GamePlaySession` config:

```csharp
entity.HasOne(x => x.Profile)
    .WithMany()
    .HasForeignKey(x => x.ProfileId)
    .OnDelete(DeleteBehavior.SetNull);

entity.HasIndex(x => new { x.ProfileId, x.StartedUtc });
```

**Test updates:**

Add a test proving deleting a profile leaves sessions intact:

```csharp
[Fact]
public async Task DeletingProfile_SetsGamePlaySessionProfileToNull()
{
    await using var fixture = await CreateFixtureAsync();
    var profile = new UserProfile { DisplayName = "Joel" };
    fixture.Db.UserProfiles.Add(profile);
    await fixture.Db.SaveChangesAsync();

    fixture.Db.GamePlaySessions.Add(new GamePlaySession
    {
        GameId = fixture.Game.Id,
        GameFileId = fixture.File.Id,
        ProfileId = profile.Id,
        Mode = "nosebleed",
        ExternalSessionId = "profile-delete",
        StartedUtc = DateTime.UtcNow
    });
    await fixture.Db.SaveChangesAsync();

    fixture.Db.UserProfiles.Remove(profile);
    await fixture.Db.SaveChangesAsync();

    var session = await fixture.Db.GamePlaySessions.SingleAsync();
    Assert.Null(session.ProfileId);
}
```

**Verification:**

Run:

```bash
dotnet test --no-restore --filter GamePlayTelemetryServiceTests
```

Expected: all telemetry tests pass.

### Task 3: Create EF migration

**Objective:** Persist profile tables and nullable play-session profile link.

**Files:**
- Create: `Migrations/YYYYMMDDHHMMSS_AddUserProfilesAndPasskeys.cs`
- Create: `Migrations/YYYYMMDDHHMMSS_AddUserProfilesAndPasskeys.Designer.cs`
- Modify: `Migrations/AppDbContextModelSnapshot.cs`

**Command:**

```bash
dotnet ef migrations add AddUserProfilesAndPasskeys
```

If `dotnet ef` is missing, install/use the local tool pattern already used in this repo, or run:

```bash
dotnet tool install --global dotnet-ef
export PATH="$PATH:/root/.dotnet/tools"
dotnet ef migrations add AddUserProfilesAndPasskeys
```

**Verification:**

Run:

```bash
dotnet test --no-restore
```

Expected: migration compiles and tests pass.

---

## Phase 2: Profile Selection Service

### Task 4: Add current-profile service

**Objective:** Centralize cookie-based profile selection so controllers do not duplicate cookie logic.

**Files:**
- Create: `Profiles/CurrentProfileService.cs`
- Modify: `Program.cs`
- Test: `tests/games-vault.Tests/CurrentProfileServiceTests.cs`

**Implementation shape:**

```csharp
namespace games_vault.Profiles;

public sealed class CurrentProfileService(AppDbContext db, IHttpContextAccessor httpContextAccessor)
{
    public const string CookieName = "gv.profile";

    public async Task<UserProfile?> GetCurrentAsync(CancellationToken ct)
    {
        var http = httpContextAccessor.HttpContext;
        if (http is null || !http.Request.Cookies.TryGetValue(CookieName, out var raw))
        {
            return null;
        }

        if (!int.TryParse(raw, out var profileId))
        {
            return null;
        }

        return await db.UserProfiles
            .AsNoTracking()
            .FirstOrDefaultAsync(x => x.Id == profileId && !x.IsArchived, ct);
    }

    public void SetCurrent(int profileId)
    {
        var http = httpContextAccessor.HttpContext ?? throw new InvalidOperationException("No active HTTP context.");
        http.Response.Cookies.Append(CookieName, profileId.ToString(CultureInfo.InvariantCulture), new CookieOptions
        {
            HttpOnly = true,
            SameSite = SameSiteMode.Lax,
            IsEssential = true,
            Expires = DateTimeOffset.UtcNow.AddYears(1)
        });
    }

    public void ClearCurrent()
    {
        httpContextAccessor.HttpContext?.Response.Cookies.Delete(CookieName);
    }
}
```

Register in `Program.cs`:

```csharp
builder.Services.AddHttpContextAccessor();
builder.Services.AddScoped<CurrentProfileService>();
```

**Verification:**

Run:

```bash
dotnet test --no-restore --filter CurrentProfileServiceTests
```

Expected: cookie parse, missing cookie, invalid cookie, archived profile, set, and clear cases pass.

### Task 4A: Add WebAuthn/passkey registration and sign-in service

**Objective:** Implement passkey-backed profile registration/sign-in while keeping controllers thin.

**Files:**
- Create: `Profiles/PasskeyService.cs`
- Create: `Controllers/PasskeysController.cs`
- Create: `wwwroot/js/passkeys.js`
- Modify: `Program.cs`
- Test: `tests/games-vault.Tests/PasskeyServiceTests.cs`

**Flow:**

Registration:

1. User enters display name/color on `Profiles/Create`.
2. Server creates a pending registration challenge with relying-party id/name and user handle.
3. Browser calls `navigator.credentials.create({ publicKey })`.
4. Browser posts attestation result to server.
5. Server verifies attestation, creates `UserProfile`, stores `UserProfilePasskey`, and selects the profile.

Sign-in/profile selection:

1. User clicks `Sign in with passkey` / `Choose profile`.
2. Server creates assertion challenge.
3. Browser calls `navigator.credentials.get({ publicKey })`.
4. Server verifies assertion against stored credential public key and signature counter.
5. Server sets the current authenticated profile cookie/session.

**Security requirements:**

- Challenges must be short-lived and server-stored; do not trust challenge values returned only from the client.
- Verify origin and relying-party id. On VAULT/LAN this may require HTTPS or a stable hostname; do not assume passkeys work from plain HTTP except localhost.
- Store only credential public keys and metadata, never private keys.
- Update signature counter/last-used timestamp after successful assertions.
- If passkey APIs are unavailable, show a clear unsupported-browser message rather than silently falling back to insecure registration.

**Verification:**

Unit-test challenge lifecycle and credential lookup with mocked verifier boundaries. Manual browser verification should cover:

- Create profile with passkey.
- Clear cookie/session.
- Sign back in with passkey.
- Attempt start-game as viewer and confirm redirect to sign-in/profile creation.

### Task 4B: Add HTTPS/hostname check for passkey readiness

**Objective:** Prevent a confusing MVP if WebAuthn is unavailable because the app is served from an origin passkeys reject.

**Files:**
- Create: `Profiles/PasskeyReadinessService.cs`
- Modify: `Views/Profiles/Create.cshtml`
- Modify: `Views/Profiles/Index.cshtml`

**Implementation notes:**

Show a warning when the current request is not a secure context for passkeys. Passkeys generally require HTTPS, except browser-specific localhost allowances. For VAULT, prefer serving Games Vault through a stable HTTPS hostname before relying on passkeys as the only registration path.

**Verification:**

- HTTPS/stable-host origin: create/sign-in buttons enabled.
- Insecure LAN HTTP origin: UI warns that passkeys may not work and points admin to HTTPS setup.

### Task 5: Add access-mode service for viewer/player/admin UI

**Objective:** Represent the three planned views explicitly so Razor views and controllers can hide/show the right surfaces consistently.

**Files:**
- Create: `Profiles/AccessMode.cs`
- Create: `Profiles/CurrentAccessService.cs`
- Modify: `Program.cs`
- Test: `tests/games-vault.Tests/CurrentAccessServiceTests.cs`

**Access model:**

```csharp
public enum AccessMode
{
    Viewer = 0,
    Player = 1,
    Admin = 2
}
```

Initial policy for this local/LAN MVP:

- `Viewer`: no selected profile; can see home dashboard active-session jumbotron and games in progress only.
- `Player`: selected non-archived passkey-authenticated profile; can browse/play/join games and see profile dashboard/history.
- `Admin`: temporary local admin flag/cookie/config switch for Joel on VAULT; can manage library/admin surfaces. Keep this simple now, but isolate it behind `CurrentAccessService` so later auth/PINs can replace the implementation.

**Implementation notes:**

`CurrentAccessService` should depend on `CurrentProfileService` and app configuration. It should expose:

```csharp
public Task<AccessMode> GetAccessModeAsync(CancellationToken ct);
public Task<bool> IsAdminAsync(CancellationToken ct);
public Task<bool> CanPlayAsync(CancellationToken ct);
public Task<bool> CanManageLibraryAsync(CancellationToken ct);
```

Do not scatter `Request.Cookies` checks across controllers/views. All access decisions should flow through this service or view data populated from it.

**Verification:**

Run:

```bash
dotnet test --no-restore --filter CurrentAccessServiceTests
```

Expected: no profile resolves to `Viewer`, selected profile resolves to `Player`, admin flag resolves to `Admin`, and permission helpers match the matrix.

### Task 6: Add selected profile and access mode to layout/view data

**Objective:** Make current profile and current access mode visible in layout/views without every view needing custom code.

**Files:**
- Create: `Profiles/CurrentProfileViewDataFilter.cs`
- Modify: `Profiles/CurrentAccessService.cs`
- Modify: `Program.cs`
- Modify: `Views/Shared/_Layout.cshtml`

**Implementation shape:**

Use an async action filter or result filter that resolves `CurrentProfileService.GetCurrentAsync()` and sets:

```csharp
ViewData["CurrentProfileName"] = profile?.DisplayName;
ViewData["CurrentProfileId"] = profile?.Id;
ViewData["AccessMode"] = accessMode.ToString();
ViewData["CanPlay"] = accessMode is AccessMode.Player or AccessMode.Admin;
ViewData["CanManageLibrary"] = accessMode is AccessMode.Admin;
```

Navbar UX:

- If profile selected: show `Playing as Joel` plus `Switch` link.
- If no profile selected: show `Viewer mode` plus `Choose profile` button/link.
- Show admin/library-management navigation only when `CanManageLibrary` is true.
- Keep active games/session jumbotron visible in viewer mode.

**Verification:**

Run app locally and inspect navbar:

```bash
dotnet run --no-build
```

Expected: no crash with no selected profile; navbar has profile affordance; viewer/player/admin navigation differs according to view data.

---

## Phase 3: Profiles Controller and UI

### Task 7: Add profile view models

**Objective:** Keep Razor views simple and avoid passing EF entities directly for profile screens.

**Files:**
- Create: `Models/ViewModels/ProfilesIndexViewModel.cs`
- Create: `Models/ViewModels/ProfileEditViewModel.cs`
- Create: `Models/ViewModels/ProfileDetailsViewModel.cs`

**View model shape:**

```csharp
public sealed class ProfilesIndexViewModel
{
    public IReadOnlyList<ProfileSummaryViewModel> Profiles { get; init; } = [];
    public int? CurrentProfileId { get; init; }
}

public sealed class ProfileSummaryViewModel
{
    public int Id { get; init; }
    public string DisplayName { get; init; } = "";
    public string Color { get; init; } = "#0d6efd";
    public int SessionCount { get; init; }
    public TimeSpan TotalPlayTime { get; init; }
    public DateTime? LastPlayedUtc { get; init; }
    public bool IsCurrent { get; init; }
}

public sealed class ProfileEditViewModel
{
    [Required]
    [StringLength(80)]
    public string DisplayName { get; set; } = "";

    [StringLength(20)]
    public string Color { get; set; } = "#0d6efd";
}
```

**Verification:**

Run:

```bash
dotnet build --no-restore
```

Expected: build passes.

### Task 8: Add `ProfilesController`

**Objective:** Create, list, select, clear, view, edit, and archive local profiles.

**Files:**
- Create: `Controllers/ProfilesController.cs`
- Test: `tests/games-vault.Tests/ProfileValidationTests.cs`

**Routes/actions:**

- `GET /Profiles` — list profiles and rollups.
- `GET /Profiles/Create` — create form.
- `POST /Profiles/Create` — validate profile fields and begin passkey registration.
- `POST /Passkeys/Register/Options` and `POST /Passkeys/Register/Complete` — complete passkey registration and save profile.
- `POST /Passkeys/Login/Options` and `POST /Passkeys/Login/Complete` — verify passkey and set current profile cookie/session.
- `POST /Profiles/Select/{id}` — for already-authenticated/current-session switching only; otherwise route through passkey verification.
- `POST /Profiles/Clear` — clear current profile cookie.
- `GET /Profiles/Details/{id}` — profile stats/history.
- `GET /Profiles/Edit/{id}` — edit name/color.
- `POST /Profiles/Edit/{id}` — save edits.
- `POST /Profiles/Archive/{id}` — soft-delete/archive profile.

**Validation rules:**

- Trim display name.
- Reject empty display name.
- Clamp max display name to 80 chars.
- Normalize color to a safe hex value or default to `#0d6efd`.
- Do not hard-delete profiles from the normal UI; archive them.

**Verification:**

Run:

```bash
dotnet test --no-restore --filter ProfileValidationTests
```

Expected: profile validation tests pass.

### Task 9: Add profile Razor views

**Objective:** Build the local profile UX.

**Files:**
- Create: `Views/Profiles/Index.cshtml`
- Create: `Views/Profiles/Create.cshtml`
- Create: `Views/Profiles/Edit.cshtml`
- Create: `Views/Profiles/Details.cshtml`
- Modify: `Views/Shared/_Layout.cshtml`

**UX requirements:**

- Profiles index has cards/buttons for each profile.
- The current profile is visually highlighted.
- Create profile is one obvious button.
- Profile details shows:
  - total play time
  - session count
  - last played
  - recent sessions
  - top games
- Archive action is visually less prominent and requires a confirmation prompt.

**Verification:**

Run:

```bash
dotnet build --no-restore
```

Expected: Razor compilation passes.

---

## Phase 4: Telemetry Attribution

### Task 10: Update `GamePlayTelemetryService.StartAsync` to accept profile id

**Objective:** Record selected profile on new sessions.

**Files:**
- Modify: `Gameplay/GamePlayTelemetryService.cs`
- Modify: `tests/games-vault.Tests/GamePlayTelemetryServiceTests.cs`

**Implementation shape:**

Change signature:

```csharp
public async Task<GamePlaySession> StartAsync(
    int gameId,
    int? fileId,
    string mode,
    string? externalSessionId,
    int? profileId,
    CancellationToken ct)
```

Set:

```csharp
ProfileId = profileId,
```

When reusing an existing active session for the same external session id, do not overwrite its original `ProfileId` unless it is null and a valid `profileId` was supplied. This prevents accidental profile switching mid-session from stealing an active session.

**Test:**

Add:

```csharp
[Fact]
public async Task StartAsync_StoresProfileIdWhenProvided()
{
    await using var fixture = await CreateFixtureAsync();
    var profile = new UserProfile { DisplayName = "Joel" };
    fixture.Db.UserProfiles.Add(profile);
    await fixture.Db.SaveChangesAsync();
    var service = new GamePlayTelemetryService(fixture.Db);

    var session = await service.StartAsync(fixture.Game.Id, fixture.File.Id, "nosebleed", "profile-session", profile.Id, CancellationToken.None);

    Assert.Equal(profile.Id, session.ProfileId);
}
```

**Verification:**

Run:

```bash
dotnet test --no-restore --filter GamePlayTelemetryServiceTests
```

Expected: all telemetry tests pass.

### Task 11: Pass current profile from gameplay controllers

**Objective:** Attach selected profile to new web/Nosebleed play sessions.

**Files:**
- Modify: `Controllers/GamesController.cs`
- Possibly modify: `Controllers/WebPlayerController.cs` if web play starts telemetry elsewhere.

**Implementation notes:**

Inject `CurrentProfileService currentProfile` into controllers that start play sessions.

In `PlayServer`, before `StartAsync`:

```csharp
var currentProfile = await currentProfileService.GetCurrentAsync(cancellationToken);
await gamePlayTelemetry.StartAsync(game.Id, file.Id, "nosebleed", session.Id, currentProfile?.Id, cancellationToken);
```

Search for all call sites:

```bash
rg "StartAsync\(" -n
```

Update every call site to pass profile id or `null`.

**Verification:**

Run:

```bash
dotnet build --no-restore
```

Expected: no call-site compile errors.

---

## Phase 5: Profile-Aware Dashboard

### Task 12: Extend dashboard stats query for profile scope

**Objective:** Let the home dashboard show selected-profile stats without losing global stats.

**Files:**
- Modify: `Gameplay/GamePlayTelemetryService.cs`
- Modify: `Models/ViewModels/HomeIndexViewModel.cs`
- Test: `tests/games-vault.Tests/GamePlayTelemetryServiceTests.cs`

**Implementation shape:**

Add overload or optional parameter:

```csharp
public async Task<GamePlayDashboardStats> GetDashboardStatsAsync(int? profileId, CancellationToken ct)
```

Behavior:

- `profileId == null` means global/all profiles.
- `profileId != null` filters `GamePlaySessions` to that profile.

Add to `HomeIndexViewModel`:

```csharp
public int? CurrentProfileId { get; set; }
public string? CurrentProfileName { get; set; }
public TimeSpan GlobalTotalPlayTime { get; set; }
public int GlobalPlaySessionCount { get; set; }
```

**Tests:**

- Global stats include anonymous and all profiles.
- Profile stats include only that profile.
- Anonymous sessions do not appear in selected-profile stats.

**Verification:**

Run:

```bash
dotnet test --no-restore --filter GamePlayTelemetryServiceTests
```

Expected: profile-filtered dashboard tests pass.

### Task 13: Update `HomeController.Index` for selected profile

**Objective:** Use profile-scoped stats on the home dashboard when a profile is selected.

**Files:**
- Modify: `Controllers/HomeController.cs`
- Modify: `Views/Home/Index.cshtml`

**Implementation notes:**

Inject `CurrentProfileService`.

In `Index`:

```csharp
var currentProfile = await currentProfileService.GetCurrentAsync(cancellationToken);
var telemetryStats = await gamePlayTelemetry.GetDashboardStatsAsync(currentProfile?.Id, cancellationToken);
var globalTelemetryStats = currentProfile is null
    ? telemetryStats
    : await gamePlayTelemetry.GetDashboardStatsAsync(null, cancellationToken);
```

Filter top-played games and recent sessions by profile when selected.

Home view copy:

- If profile selected: `Joel's dashboard`
- If no profile selected: `All-player dashboard`
- If no profile and profiles exist: show CTA `Choose a profile to track your play time`.
- Keep active Nosebleed session jumbotron global for now, but display profile name on active session cards if known.

**Verification:**

Manual:

- No profile selected: dashboard remains global.
- Profile selected: dashboard title and stats switch to that profile.
- Active sessions still show.

---

## Phase 6: Profile History and Future Save Hooks

### Task 14: Add profile details rollups

**Objective:** Make profile pages useful immediately.

**Files:**
- Modify: `Controllers/ProfilesController.cs`
- Modify: `Models/ViewModels/ProfileDetailsViewModel.cs`
- Modify: `Views/Profiles/Details.cshtml`

**Data to show:**

- Total play time.
- Session count.
- Last played game.
- Top 10 games by total play time.
- Recent 25 play sessions with game, mode, duration, started time, end reason.

**Verification:**

Seed a few sessions manually in a test or dev DB and confirm profile details rollups match expected totals.

### Task 15: Add placeholder fields/links for per-profile saves without implementing save splitting yet

**Objective:** Prepare the UX for per-profile saves while avoiding a risky save-file migration today.

**Files:**
- Modify: `Views/Profiles/Details.cshtml`
- Create/modify docs: `docs/plans/2026-05-21-profile-saves-followup.md` if needed

**UX:**

Add an empty-state card:

- Title: `Profile saves`
- Text: `Coming next: save files and save states scoped to this profile.`

**Do not:**

- Move or rename existing save files yet.
- Change `GamePlayerFile` paths yet.
- Split saves by profile until the save pipeline is mapped and tested.

**Verification:**

Razor build passes.

---

## Phase 7: Polish, Verification, and Deploy

### Task 16: Add navigation polish and empty states

**Objective:** Make profiles feel first-class without cluttering the app.

**Files:**
- Modify: `Views/Shared/_Layout.cshtml`
- Modify: `Views/Home/Index.cshtml`
- Modify: `wwwroot/css/site.css` if needed

**Requirements:**

- Navbar has a `Profiles` link.
- Current profile badge is compact on mobile.
- Home dashboard has a clear no-profile CTA.
- Profile cards are large touch targets for mobile/tablet use.

### Task 17: Full verification

**Objective:** Prove the feature is safe to ship.

**Commands:**

```bash
dotnet test --no-restore
node tests/nosebleed-input-helpers.test.cjs
node tests/nosebleed-preview.test.cjs
dotnet build -c Release --no-restore
```

Expected:

- All xUnit tests pass.
- Nosebleed JS tests pass.
- Release build succeeds with zero errors.

### Task 18: Publish and restart on VAULT

**Objective:** Deploy after local verification.

**Commands:**

```bash
dotnet publish games-vault.csproj -c Release -o /opt/games-vault
systemctl restart games-vault
systemctl is-active games-vault
curl -I http://127.0.0.1:8090/
```

Expected:

- Service is `active`.
- Local HTTP check returns `200 OK`.
- `/Profiles` loads.
- Home page loads with no selected profile.
- Creating/selecting a profile updates navbar/home dashboard.

---

## Follow-Up Plan: Per-Profile Saves and High Scores

Do after the local profile MVP lands:

1. Map current web-player and Nosebleed save file flows.
2. Decide save namespace format, likely `{profileId}/{gameId}/{kind}/{key}/{fileName}`.
3. Add `ProfileId` to `GamePlayerFile` as nullable with migration.
4. Implement save lookup priority:
   - selected profile save
   - optionally global legacy save
   - no save
5. Add explicit import/migrate action for legacy saves.
6. Add `GameStatSnapshot` / `ProfileGameStat` tables after memory-address spikes are verified.
7. For Sonic 2 Game Gear, use verified memory-derived `highest observed ring count * current lives` as the initial arcade score metric.

## Risks and Guardrails

- Do not overbuild email/password auth or account recovery in this pass; passkeys are the MVP registration/sign-in mechanism.
- Do preserve a clean authorization boundary: viewer, passkey-authenticated player, admin.
- Do not expose add/import/edit/delete/library-management controls to viewer/player modes once the access-mode service lands.
- Do not expose destructive Nosebleed process/session cleanup to viewer/player modes; those are admin controls.
- Do not make profiles mandatory for viewing active games in progress.
- Do require a selected passkey-authenticated profile for starting gameplay once access gating lands.
- Do not break anonymous/global historical sessions.
- Do not move existing saves yet.
- Do not trust profile id from query string/form for telemetry; use the current-profile service/cookie.
- Use soft archive for profiles so old session attribution is not lost.
- Keep destructive profile actions out of the primary flow.
