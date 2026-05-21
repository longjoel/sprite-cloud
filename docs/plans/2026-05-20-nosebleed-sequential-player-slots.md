# Nosebleed Sequential Player Slots Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Make each concurrent visitor to a games-vault server-side playback session receive the next available libretro controller slot: first visitor gets P1/port 0, second gets P2/port 1, third gets P3/port 2, fourth gets P4/port 3; later visitors are spectators unless/until a slot frees.

**Architecture:** Keep Nosebleed as the authoritative input enforcer because it already validates `allowed_ports` in signed tokens and reserves ports per input source. Add a games-vault session seating layer that allocates player slots before signing the Nosebleed token, persists the assignment in a browser cookie, and renders the assigned port into `PlayServer.cshtml` so browser input is sent to the assigned port instead of hard-coded port 0.

**Tech Stack:** ASP.NET Core MVC/.NET 10, games-vault sidecar orchestration, HMAC Nosebleed tickets, Nosebleed WebSocket input (`/ws/input`), Rust Nosebleed port reservation.

---

## Current state

- Nosebleed already supports player tokens with `allowed_ports`.
- Nosebleed already enforces ownership in `apps/nosebleed/src/server.rs`:
  - `InputSessionRegistry.reserve_ports(...)`
  - `process_input_payload(...)` rejects `port X not assigned to this player`.
- games-vault currently signs every server-side player as port 0 in `NosebleedTicketSigner.CreatePlayerToken(..., int port = 0)`.
- `Views/Games/PlayServer.cshtml` currently sends all browser input with `port: 0`.
- `NosebleedSessionManager` currently reuses a sidecar process per game/file but does not track seats/players.

## Desired behavior

1. First browser/client joining a `PlayServer` session gets port 0 / Player 1.
2. Second distinct browser/client joining the same session gets port 1 / Player 2.
3. Third gets port 2 / Player 3.
4. Fourth gets port 3 / Player 4.
5. Fifth and later visitors are spectators by default.
6. Refreshing/reopening from the same browser should preserve the same seat while the assignment is valid.
7. A disconnected/stale player seat should eventually free for a new player.
8. Nosebleed must remain the enforcement boundary: clients cannot claim another port just by editing JS.

## Terminology

- **Libretro port:** zero-based controller port used by Nosebleed and libretro (`0..3`).
- **Display player number:** one-based label shown to humans (`P1..P4`).
- **Viewer id:** stable per-browser random id stored in a games-vault cookie.
- **Seat assignment:** `(sessionId, viewerId) -> port` stored server-side.
- **Spectator token:** token that can view video/audio but cannot send input. If Nosebleed does not currently accept explicit spectator tokens in this path, do not issue an input token for spectators and hide/disable input controls.

---

## Task 1: Add server-side seating model to games-vault

**Objective:** Represent seat assignment results independently from Nosebleed process lifetime.

**Files:**
- Create: `Nosebleed/NosebleedSeatAssignment.cs`

**Implementation:**

```csharp
namespace games_vault.Nosebleed;

public enum NosebleedSeatKind
{
    Player,
    Spectator
}

public sealed record NosebleedSeatAssignment(
    NosebleedSeatKind Kind,
    string ViewerId,
    int? Port,
    DateTimeOffset AssignedUtc,
    DateTimeOffset ExpiresUtc)
{
    public int? PlayerNumber => Port is null ? null : Port.Value + 1;
}
```

**Verification:**

Run:

```bash
dotnet build games-vault.sln -c Release --no-restore
```

Expected: build succeeds.

---

## Task 2: Add seating options

**Objective:** Make max player count and seat TTL configurable.

**Files:**
- Modify: `Nosebleed/NosebleedOptions.cs`
- Modify: `appsettings.json`

**Implementation:**

Add to `NosebleedOptions`:

```csharp
public int MaxPlayersPerSession { get; set; } = 4;

public int SeatTtlMinutes { get; set; } = 30;
```

Add to the `Nosebleed` section in `appsettings.json`:

```json
"MaxPlayersPerSession": 4,
"SeatTtlMinutes": 30
```

**Verification:**

Run:

```bash
dotnet build games-vault.sln -c Release --no-restore
```

Expected: build succeeds.

---

## Task 3: Create seat manager

**Objective:** Allocate first available port per session and keep the same browser on the same port.

**Files:**
- Create: `Nosebleed/NosebleedSeatManager.cs`
- Test later after test project decision; for now include deterministic internal methods and verify manually.

**Implementation outline:**

```csharp
using System.Collections.Concurrent;
using Microsoft.Extensions.Options;

namespace games_vault.Nosebleed;

public sealed class NosebleedSeatManager(IOptions<NosebleedOptions> options)
{
    private readonly NosebleedOptions _options = options.Value ?? new NosebleedOptions();
    private readonly ConcurrentDictionary<string, object> _locks = new();
    private readonly ConcurrentDictionary<string, List<NosebleedSeatAssignment>> _seats = new();

    public NosebleedSeatAssignment Assign(string sessionId, string viewerId, DateTimeOffset now)
    {
        var gate = _locks.GetOrAdd(sessionId, _ => new object());
        lock (gate)
        {
            var seats = _seats.GetOrAdd(sessionId, _ => []);
            CleanupExpired(seats, now);

            var existing = seats.FirstOrDefault(s => s.ViewerId == viewerId);
            if (existing is not null)
            {
                seats.Remove(existing);
                var refreshed = existing with { ExpiresUtc = now.AddMinutes(SeatTtlMinutes()) };
                seats.Add(refreshed);
                return refreshed;
            }

            var maxPlayers = Math.Clamp(_options.MaxPlayersPerSession, 1, 4);
            var usedPorts = seats.Where(s => s.Kind == NosebleedSeatKind.Player && s.Port is not null)
                                 .Select(s => s.Port!.Value)
                                 .ToHashSet();
            var freePort = Enumerable.Range(0, maxPlayers).FirstOrDefault(p => !usedPorts.Contains(p), -1);

            var assignment = freePort >= 0
                ? new NosebleedSeatAssignment(NosebleedSeatKind.Player, viewerId, freePort, now, now.AddMinutes(SeatTtlMinutes()))
                : new NosebleedSeatAssignment(NosebleedSeatKind.Spectator, viewerId, null, now, now.AddMinutes(SeatTtlMinutes()));

            seats.Add(assignment);
            return assignment;
        }
    }

    public void Release(string sessionId, string viewerId)
    {
        if (!_seats.TryGetValue(sessionId, out var seats)) return;
        var gate = _locks.GetOrAdd(sessionId, _ => new object());
        lock (gate)
        {
            seats.RemoveAll(s => s.ViewerId == viewerId);
        }
    }

    private int SeatTtlMinutes() => Math.Max(1, _options.SeatTtlMinutes);

    private static void CleanupExpired(List<NosebleedSeatAssignment> seats, DateTimeOffset now)
        => seats.RemoveAll(s => s.ExpiresUtc <= now);
}
```

**Important details:**

- The first available port is always the lowest unused port.
- Do not let client-provided data choose the port.
- The assignment should be per `sessionId`, not per game globally.
- Spectators get `Port = null`.

**Verification:**

Run:

```bash
dotnet build games-vault.sln -c Release --no-restore
```

Expected: build succeeds.

---

## Task 4: Register seat manager in DI

**Objective:** Make seating available to MVC controller actions.

**Files:**
- Modify: `Program.cs`

**Implementation:**

Add after existing Nosebleed services:

```csharp
builder.Services.AddSingleton<NosebleedSeatManager>();
```

**Verification:**

Run:

```bash
dotnet build games-vault.sln -c Release --no-restore
```

Expected: build succeeds.

---

## Task 5: Extend player view model with seat info

**Objective:** Let the Razor view know which player/port this browser owns.

**Files:**
- Modify: `Models/ViewModels/ServerGamePlayViewModel.cs`

**Implementation:**

Add properties:

```csharp
public int? AssignedPort { get; init; }
public int? PlayerNumber { get; init; }
public bool IsSpectator { get; init; }
public DateTimeOffset? SeatExpiresUtc { get; init; }
```

**Verification:**

Run:

```bash
dotnet build games-vault.sln -c Release --no-restore
```

Expected: build succeeds.

---

## Task 6: Add viewer id cookie helper in `GamesController`

**Objective:** Identify repeat visits from the same browser without a login system.

**Files:**
- Modify: `Controllers/GamesController.cs`

**Implementation outline:**

Add constants/helper methods near the bottom of the controller:

```csharp
private const string NosebleedViewerCookieName = "games_vault_nosebleed_viewer";

private string GetOrCreateNosebleedViewerId()
{
    if (Request.Cookies.TryGetValue(NosebleedViewerCookieName, out var existing)
        && Guid.TryParse(existing, out _))
    {
        return existing;
    }

    var id = Guid.NewGuid().ToString("N");
    Response.Cookies.Append(NosebleedViewerCookieName, id, new CookieOptions
    {
        HttpOnly = true,
        SameSite = SameSiteMode.Lax,
        Secure = Request.IsHttps,
        MaxAge = TimeSpan.FromDays(30)
    });
    return id;
}
```

**Verification:**

Run:

```bash
dotnet build games-vault.sln -c Release --no-restore
```

Expected: build succeeds.

---

## Task 7: Allocate seat in `PlayServer`

**Objective:** Assign the browser to P1/P2/P3/P4 before creating its Nosebleed token.

**Files:**
- Modify: `Controllers/GamesController.cs`

**Implementation outline:**

Inject the seat manager into `GamesController` constructor:

```csharp
NosebleedSeatManager nosebleedSeats
```

Inside `PlayServer`, after `session` exists:

```csharp
var viewerId = GetOrCreateNosebleedViewerId();
var seat = nosebleedSeats.Assign(session.Id, viewerId, DateTimeOffset.UtcNow);

var token = seat.Kind == NosebleedSeatKind.Player && seat.Port is not null
    ? ticketSigner.CreatePlayerToken(session.Id, viewerId, seat.Port.Value)
    : null;
```

Set model properties:

```csharp
Token = token,
AssignedPort = seat.Port,
PlayerNumber = seat.PlayerNumber,
IsSpectator = seat.Kind == NosebleedSeatKind.Spectator,
SeatExpiresUtc = seat.ExpiresUtc
```

**Acceptance criteria:**

- First unique browser gets token with `allowed_ports: [0]`.
- Second unique browser gets token with `allowed_ports: [1]`.
- Refresh in same browser preserves the same `ViewerId` and port.
- Fifth unique browser gets spectator state and no input token.

**Verification:**

Run:

```bash
dotnet build games-vault.sln -c Release --no-restore
```

Expected: build succeeds.

---

## Task 8: Update PlayServer UI labels and input port

**Objective:** Show the assigned player number and send input to the assigned port.

**Files:**
- Modify: `Views/Games/PlayServer.cshtml`

**Implementation outline:**

Near the status block, show:

```cshtml
@if (Model.IsSpectator)
{
    <span class="badge bg-secondary">Spectator</span>
}
else if (Model.PlayerNumber is not null)
{
    <span class="badge bg-success">Player @Model.PlayerNumber</span>
}
```

In JavaScript, add:

```js
const assignedPort = @Html.Raw(System.Text.Json.JsonSerializer.Serialize(Model.AssignedPort));
const isSpectator = @Html.Raw(System.Text.Json.JsonSerializer.Serialize(Model.IsSpectator));
```

Update help text:

```text
You are Player N. Keyboard and gamepad input are forwarded to controller port N.
```

In `connect()`, only open `/ws/input` if not spectator:

```js
if (!isSpectator && assignedPort !== null) {
    inputWs = new WebSocket(withToken("/ws/input"));
    ...
}
```

In `sendInput()`, replace hard-coded port 0:

```js
inputWs.send(JSON.stringify({ type: "input", port: assignedPort, sequence: ++inputSeq, buttons, axes }));
```

Gamepad note should change from:

```text
Browser gamepads are also forwarded to port 0.
```

to:

```text
Browser gamepads are forwarded to your assigned controller slot.
```

**Verification:**

Run:

```bash
dotnet build games-vault.sln -c Release --no-restore
```

Expected: build succeeds.

---

## Task 9: Add optional explicit leave/release endpoint

**Objective:** Let a user free their seat without waiting for TTL.

**Files:**
- Modify: `Controllers/GamesController.cs`
- Modify: `Views/Games/PlayServer.cshtml`

**Implementation outline:**

Controller action:

```csharp
[HttpPost]
[ValidateAntiForgeryToken]
public IActionResult LeaveServerSession(string sessionId)
{
    if (Request.Cookies.TryGetValue(NosebleedViewerCookieName, out var viewerId))
    {
        nosebleedSeats.Release(sessionId, viewerId);
    }
    return RedirectToAction(nameof(Index));
}
```

View button:

```cshtml
<form asp-action="LeaveServerSession" method="post" class="d-inline">
    <input type="hidden" name="sessionId" value="@Model.SessionId" />
    <button type="submit" class="btn btn-outline-warning">Leave seat</button>
</form>
```

**Verification:**

- Open `PlayServer` in one browser; see P1.
- Click Leave seat.
- Open from another fresh browser; it should get P1.

---

## Task 10: Add tests for allocation logic

**Objective:** Protect the most important concurrency behavior.

**Files:**
- Create or modify test project if one exists. If none exists, create a lightweight xUnit test project:
  - `tests/games-vault.Tests/games-vault.Tests.csproj`
  - `tests/games-vault.Tests/NosebleedSeatManagerTests.cs`
  - Add to `games-vault.sln`

**Test cases:**

1. Four unique viewers get ports `0,1,2,3`.
2. Fifth viewer is spectator.
3. Same viewer gets same port on refresh.
4. Expired seat frees port for next viewer.
5. Released seat frees port for next viewer.

**Example test shape:**

```csharp
[Fact]
public void Assign_GivesFirstFourViewersSequentialPorts()
{
    var manager = CreateManager(maxPlayers: 4, ttlMinutes: 30);
    var now = DateTimeOffset.UtcNow;

    manager.Assign("s1", "v1", now).Port.Should().Be(0);
    manager.Assign("s1", "v2", now).Port.Should().Be(1);
    manager.Assign("s1", "v3", now).Port.Should().Be(2);
    manager.Assign("s1", "v4", now).Port.Should().Be(3);
}
```

Use xUnit assertions or FluentAssertions depending on existing project conventions. Prefer no extra dependency if the repo has no test setup.

**Verification:**

Run:

```bash
dotnet test games-vault.sln -c Release --no-restore
```

Expected: all tests pass.

---

## Task 11: Runtime verification on VAULT

**Objective:** Prove real multi-browser port assignment works with Nosebleed enforcement.

**Commands:**

Publish/restart:

```bash
cd /root/projects/games-vault
dotnet publish games-vault.csproj -c Release -o /opt/games-vault
systemctl restart games-vault
systemctl is-active games-vault
```

Test one local request:

```bash
curl -sS -i http://127.0.0.1:8090/Games/PlayServer/1 | sed -n '1,80p'
```

Manual browser test:

1. Open normal browser profile to `/Games/PlayServer/1`; expect `Player 1`.
2. Open private/incognito profile; expect `Player 2`.
3. Open another browser/device; expect `Player 3`.
4. Open fourth unique browser/device; expect `Player 4`.
5. Open fifth unique browser/device; expect `Spectator` and no input enabled.
6. Confirm each player's browser sends `port` equal to assigned zero-based port.
7. Confirm editing JS to send another player's port yields Nosebleed error: `port X not assigned to this player`.

**Log checks:**

```bash
journalctl -u games-vault --since '10 min ago' --no-pager | grep -Ei 'nosebleed|error|warn|exception'
pgrep -af '/opt/nosebleed/nosebleed'
ss -tulpn | awk 'NR==1 || /:81[0-9][0-9]/'
```

---

## Open questions / follow-ups

- Should spectators be able to watch video/audio with a dedicated spectator token? Nosebleed has stream auth concepts; if current games-vault signer only issues player tokens, add `CreateSpectatorToken(...)` later.
- Should player slots be visible in a lobby/sidebar with names? For MVP, anonymous `Player 1`/`Player 2` labels are enough.
- Should seats be tracked per active sidecar session only or persisted in DB? MVP should remain in-memory.
- Should the maximum slots come from game metadata `NumberOfPlayers` when present? Future improvement: `min(Nosebleed.MaxPlayersPerSession, game.NumberOfPlayers ?? 4)`.

## Recommended commit sequence

1. `feat: add nosebleed seat assignment model`
2. `feat: allocate server playback seats`
3. `feat: render assigned nosebleed player slot`
4. `test: cover nosebleed seat allocation`
5. `docs: add sequential player slot plan`
