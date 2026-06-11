# Pin Games to Home Screen — Implementation Plan

> **For Hermes:** Execute task-by-task. Each task is a self-contained unit with exact paths and code.

**Goal:** Users and admins can pin games to their home screen for quick access.

**Architecture:** New `ProfilePinnedGame` join table links a `UserProfile` to a `Game`. A `TogglePin` endpoint toggles the pin. Home page shows pinned games above "Continue playing". Game cards in the library get a pin toggle button.

**Tech Stack:** ASP.NET Core, EF Core, PostgreSQL, Razor views, Bootstrap

---

### Task 1: Create the ProfilePinnedGame model

**Objective:** Add the join entity that links a profile to a pinned game.

**Files:**
- Create: `Models/ProfilePinnedGame.cs`

**Step 1: Create the model file**

```csharp
namespace games_vault.Models;

public sealed class ProfilePinnedGame
{
    public int Id { get; set; }
    public int ProfileId { get; set; }
    public UserProfile Profile { get; set; } = null!;
    public int GameId { get; set; }
    public Game Game { get; set; } = null!;
    public bool IsArchived { get; set; }
    public DateTime CreatedUtc { get; set; } = DateTime.UtcNow;
}
```

**Step 2: Build**

Run: `dotnet build -c Release`

Expected: Build succeeds (model file exists but no EF config yet; no errors since nothing references it).

---

### Task 2: Add EF Core configuration for ProfilePinnedGame

**Objective:** Register the entity in the DbContext with proper relationships.

**Files:**
- Create: `Data/Configurations/ProfilePinnedGameConfiguration.cs`
- Modify: `Data/AppDbContext.cs`

**Step 1: Create the configuration**

```csharp
using games_vault.Models;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;

namespace games_vault.Data.Configurations;

public sealed class ProfilePinnedGameConfiguration : IEntityTypeConfiguration<ProfilePinnedGame>
{
    public void Configure(EntityTypeBuilder<ProfilePinnedGame> builder)
    {
        builder.HasKey(x => x.Id);

        builder.HasIndex(x => new { x.ProfileId, x.GameId })
            .IsUnique()
            .HasFilter("NOT \"IsArchived\"");

        builder.HasOne(x => x.Profile)
            .WithMany()
            .HasForeignKey(x => x.ProfileId)
            .OnDelete(DeleteBehavior.Cascade);

        builder.HasOne(x => x.Game)
            .WithMany()
            .HasForeignKey(x => x.GameId)
            .OnDelete(DeleteBehavior.Cascade);
    }
}
```

**Step 2: Add DbSet to AppDbContext**

In `Data/AppDbContext.cs`, add after the existing DbSets:

```csharp
public DbSet<ProfilePinnedGame> ProfilePinnedGames => Set<ProfilePinnedGame>();
```

And in `OnModelCreating` (find the `modelBuilder.ApplyConfigurationsFromAssembly` call area), make sure the configuration is picked up. The existing code likely already calls `ApplyConfigurationsFromAssembly` so this should be automatic.

**Step 3: Build**

Run: `dotnet build -c Release`

Expected: Build succeeds.

---

### Task 3: Add migration

**Objective:** Generate and apply the EF migration for the new table.

**Step 1: Generate migration**

```bash
cd /root/projects/games-vault
dotnet ef migrations add AddProfilePinnedGames
```

Expected: Migration file created in Migrations/.

**Step 2: Build**

Run: `dotnet build -c Release`

Expected: Build succeeds.

---

### Task 4: Add TogglePin endpoint to GamesController

**Objective:** Create a POST endpoint that toggles pin status for the current profile.

**Files:**
- Modify: `Controllers/GamesController.cs`

**Step 1: Add the endpoint**

Add this method to `GamesController` (it already has `db`, `currentProfile`, and `currentAccess` injected):

```csharp
[HttpPost]
[ValidateAntiForgeryToken]
public async Task<IActionResult> TogglePin(int id, CancellationToken cancellationToken = default)
{
    if (!await currentAccess.CanPlayAsync(cancellationToken))
    {
        return Json(new { error = "Sign in to pin games." });
    }

    var profile = await currentProfile.GetCurrentAsync(cancellationToken);
    if (profile is null)
    {
        return Json(new { error = "Sign in to pin games." });
    }

    var gameExists = await db.Games.AnyAsync(x => x.Id == id, cancellationToken);
    if (!gameExists)
    {
        return NotFound();
    }

    var existing = await db.ProfilePinnedGames
        .FirstOrDefaultAsync(x => x.ProfileId == profile.Id && x.GameId == id, cancellationToken);

    bool pinned;
    if (existing is not null)
    {
        if (existing.IsArchived)
        {
            existing.IsArchived = false;
            pinned = true;
        }
        else
        {
            existing.IsArchived = true;
            pinned = false;
        }
    }
    else
    {
        db.ProfilePinnedGames.Add(new ProfilePinnedGame
        {
            ProfileId = profile.Id,
            GameId = id,
            CreatedUtc = DateTime.UtcNow
        });
        pinned = true;
    }

    await db.SaveChangesAsync(cancellationToken);
    return Json(new { pinned });
}
```

**Step 2: Build**

Run: `dotnet build -c Release`

Expected: Build succeeds.

---

### Task 5: Add pin button to game cards in _GamesBank

**Objective:** Add a small pin toggle button to each game card, visible to signed-in users.

**Files:**
- Modify: `Views/Games/_GamesBank.cshtml`

**Step 1: Add the pin button**

In `_GamesBank.cshtml`, inside the game card's primary actions area (around line 137, the `games-primary-actions` div), add the pin button **before** the "Play" button:

Find this block (around line 134):
```html
<div class="games-primary-actions d-flex flex-wrap gap-2 mt-auto">
    @{
        var isGuest = ViewData["CurrentProfileId"] is not int;
    }
    <a class="btn btn-primary" asp-action="PlayServer" asp-route-id="@game.Id">@(isGuest ? "Watch" : "Play")</a>
```

Insert the pin button right before the `<a class="btn btn-primary" ...>` line:

```html
    @if (!isGuest)
    {
        <button class="btn btn-sm btn-outline-secondary pin-toggle"
                type="button"
                data-game-id="@game.Id"
                title="Pin to home screen">
            📌
        </button>
    }
```

**Step 2: Add JS for pin toggling**

At the bottom of `_GamesBank.cshtml` (but inside the `@if (Model.Games.Count > 0)` block), add a script section. Actually, better: add a small inline script at the bottom of the Games/Index.cshtml page (which loads this partial). Let's add it to `Views/Games/Index.cshtml` in the `@section Scripts`:

After the existing pagination click handler (around line 308), add:

```javascript
// Pin toggle
if (bankContainer) {
    bankContainer.addEventListener('click', async function(e) {
        var btn = e.target.closest('.pin-toggle');
        if (!btn) return;
        e.preventDefault();
        var gameId = btn.getAttribute('data-game-id');
        var csrfToken = document.querySelector('input[name="__RequestVerificationToken"]')?.value ?? '';
        try {
            var res = await fetch('/Games/TogglePin/' + gameId, {
                method: 'POST',
                headers: { 'X-CSRF-TOKEN': csrfToken },
                credentials: 'same-origin'
            });
            if (!res.ok) return;
            var data = await res.json();
            btn.classList.toggle('active', data.pinned);
            btn.title = data.pinned ? 'Unpin from home screen' : 'Pin to home screen';
        } catch {}
    });
}
```

Also update the pin button in the view to reflect initial state. We need the view model to carry pinned game IDs. Let's add that to `GamesBankViewModel`.

Modify `Models/ViewModels/GamesBankViewModel.cs` — add:
```csharp
public HashSet<int> PinnedGameIds { get; set; } = new();
```

Then load it in `GamesController.Index` (or the Bank action) — we'll need to query `db.ProfilePinnedGames` for the current profile.

Update the pin button:
```html
    @if (!isGuest)
    {
        var isPinned = Model.PinnedGameIds.Contains(game.Id);
        <button class="btn btn-sm btn-outline-secondary pin-toggle @(isPinned ? "active" : "")"
                type="button"
                data-game-id="@game.Id"
                title="@(isPinned ? "Unpin from home screen" : "Pin to home screen")">
            📌
        </button>
    }
```

**Step 3: Load PinnedGameIds in GamesController**

In `Controllers/GamesController.cs`, find the `Index` action (or `Bank` action). Load pinned game IDs:

```csharp
var pinnedGameIds = currentUserProfile is not null
    ? await db.ProfilePinnedGames
        .AsNoTracking()
        .Where(x => x.ProfileId == currentUserProfile.Id && !x.IsArchived)
        .Select(x => x.GameId)
        .ToListAsync(cancellationToken)
    : new List<int>();
```

And pass `PinnedGameIds = new HashSet<int>(pinnedGameIds)` to the bank view model.

**Step 4: Build**

Run: `dotnet build -c Release`

Expected: Build succeeds.

---

### Task 6: Show pinned games on home page

**Objective:** Add a "Pinned" section above "Continue playing" on the signed-in home page.

**Files:**
- Modify: `Controllers/HomeController.cs`
- Modify: `Models/ViewModels/HomeIndexViewModel.cs`
- Modify: `Views/Home/Index.cshtml`

**Step 1: Add PinnedGames to view model**

In `HomeIndexViewModel.cs`, add:
```csharp
public IReadOnlyList<HomePinnedGameViewModel> PinnedGames { get; set; } = [];
```

And add the view model class (same file):
```csharp
public sealed class HomePinnedGameViewModel
{
    public int GameId { get; set; }
    public string GameName { get; set; } = "";
    public string SystemName { get; set; } = "";
}
```

**Step 2: Load pinned games in HomeController.Index**

In `HomeController.cs`, after loading the current profile (~line 37), add:

```csharp
var pinnedGames = currentUserProfile is not null
    ? await db.ProfilePinnedGames
        .AsNoTracking()
        .Where(x => x.ProfileId == currentUserProfile.Id && !x.IsArchived)
        .OrderBy(x => x.CreatedUtc)
        .Select(x => new HomePinnedGameViewModel
        {
            GameId = x.GameId,
            GameName = x.Game.Name,
            SystemName = x.Game.SystemName
        })
        .ToListAsync(cancellationToken)
    : [];
```

And add `PinnedGames = pinnedGames` to the `HomeIndexViewModel` constructor call.

**Step 3: Add pinned section to home view**

In `Views/Home/Index.cshtml`, inside the signed-in block (`@if (Model.CurrentProfileId is not null && Model.ShowDashboard)`), add BEFORE the "Continue playing" section:

```html
@if (Model.PinnedGames.Count > 0)
{
    <section class="mb-4">
        <h2 class="h5 mb-3">Pinned</h2>
        <div class="d-flex gap-2 flex-wrap">
            @foreach (var game in Model.PinnedGames)
            {
                <a class="btn btn-outline-secondary" asp-controller="Games" asp-action="PlayServer" asp-route-id="@game.GameId">
                    📌 @game.GameName
                </a>
            }
        </div>
    </section>
}
```

**Step 4: Build**

Run: `dotnet build -c Release`

Expected: Build succeeds.

---

### Task 7: Add CSS for active pin state

**Objective:** Style the pin button active state.

**Files:**
- Modify: `wwwroot/css/site.css`

**Step 1: Add pin button styles**

Add at the end of site.css:
```css
/* --- Pin toggle --- */
.pin-toggle.active {
  background: var(--accent) !important;
  border-color: var(--accent) !important;
  color: #fff !important;
}
```

**Step 2: Build**

Run: `dotnet build -c Release`

Expected: Build succeeds.

---

### Task 8: Run tests, fix any, deploy

**Step 1: Build and test**

```bash
cd /root/projects/games-vault
dotnet build -c Release
dotnet test -c Release
```

Expected: All tests pass (216+).

**Step 2: Deploy**

```bash
dotnet publish -c Release -o /tmp/gv-publish
sudo systemctl stop games-vault
sudo cp -r /tmp/gv-publish/* /opt/games-vault/
sudo cp -r Views /opt/games-vault/
sudo cp -r wwwroot /opt/games-vault/
sudo systemctl start games-vault
```

**Step 3: Verify**

- Sign in → Home shows "Pinned" section (empty)
- Go to Games → Pin a game via 📌 button
- Go to Home → Pinned game appears
- Click pinned game → opens PlayServer
- Unpin via 📌 button → disappears from home

**Step 4: Commit**

```bash
git add -A
git commit -m "feat: pin games to home screen"
```

---

### Task 9: Commit and push

**Step 1: Commit**

```bash
git add -A
git commit -m "feat: pin games to home screen for quick access"
git push
```
