# Issue #5 — Better Game Session Management Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Implement multi-session game rooms with share codes, viewer/player separation, single-active-login enforcement per profile, participant presence, lightweight room chat, and safe pruning of orphan Nosebleed processes.

**Architecture:** Add a persistent "Play Room" layer in Games Vault DB that maps game files to multiple concurrently active sessions (each with a 4-letter share code). Keep Nosebleed runtime as execution backend, but move room lifecycle and membership/state enforcement into app-level services (room service + presence service + auth-session service). Use current WebSocket proxy path and signed tokens, while introducing room-scoped routing and policy checks before issuing input tokens.

**Tech Stack:** ASP.NET Core MVC, EF Core (SQLite existing), existing NosebleedSessionManager + NosebleedSeatManager, current profile cookie auth (`gv.profile`), server-rendered Razor + progressive JS polling.

---

## Current State Snapshot (important)

- `GamesController.PlayServer(int id)` currently starts/reuses a single session per `(gameId,fileId,corePath,contentPath)` via `NosebleedSessionManager.StartOrReuseAsync(...)`.
- Session seat assignment is in-memory only (`NosebleedSeatManager`) keyed by `viewerId` cookie (`games_vault_nosebleed_viewer`), with TTL refresh through `KeepAliveServerSession`.
- Proxy route exists: `GET Games/NosebleedProxy?sessionId=...&channel=video|audio|input`.
- Input access is already enforced server-side by seat kind + signed ticket.
- Profile sign-in is cookie-based (`gv.profile`) with no persistent “auth session id”, so one profile can currently remain active on many devices/tabs.
- There is no room chat/presence roster model yet.

---

## Scope split for issue #5

### In scope now
1. Multiple concurrent sessions per game with join/create choice.
2. 4-letter share code room discovery and join flow.
3. Logged-out users can watch but not control.
4. Controller port assignment on join (existing seat manager reused).
5. Single active login session per profile (newest wins across tabs/devices).
6. Presence display: named players + watcher count.
7. Basic text-only room chat tied to profile identity (watchers can read, profiles can post).
8. Prune Nosebleed processes with no active room or arcade linkage.

### Deferred (separate issue)
- OAuth migration (already issue #4).
- Distributed workers burst routing (future architecture track).
- Rich real-time chat transport (SignalR/WebRTC datachannel) — start with polling.

---

## Task 1: Create room domain models and DB migration

**Objective:** Persist room/session state, participants, chat, and auth session ownership.

**Files:**
- Create: `Models/GamePlayRoom.cs`
- Create: `Models/GamePlayRoomParticipant.cs`
- Create: `Models/GamePlayRoomChatMessage.cs`
- Create: `Models/ProfileAuthSession.cs`
- Modify: `Data/AppDbContext.cs`
- Create: `Migrations/<timestamp>_AddRoomSessionManagement.cs`

**Step 1: Write failing model/migration tests**
- Add/extend DB tests to assert new DbSets and FK constraints exist.

**Step 2: Run test to verify failure**
- `dotnet test --filter RoomSessionManagement`

**Step 3: Implement minimal models**
- `GamePlayRoom`: `Id`, `Code4`, `GameId`, `GameFileId`, `NosebleedSessionId`, `CreatedByProfileId`, `Status`, `CreatedUtc`, `LastActiveUtc`, `ClosedUtc`, `IsArcadeBound`, `ArcadeCabinetId`.
- `GamePlayRoomParticipant`: `RoomId`, `ViewerId`, nullable `ProfileId`, `DisplayNameSnapshot`, `Role` (player/spectator), `Port`, `JoinedUtc`, `LastSeenUtc`, `IsConnected`.
- `GamePlayRoomChatMessage`: `RoomId`, nullable `ProfileId`, `DisplayNameSnapshot`, `Message`, `CreatedUtc`.
- `ProfileAuthSession`: `Id(Guid)`, `ProfileId`, `SessionNonce`, `UserAgentHash`, `LastSeenUtc`, `RevokedUtc`.

**Step 4: Add DbSets + indexes**
- Unique index on `GamePlayRoom.Code4` while active.
- Index on `ProfileAuthSession(ProfileId, RevokedUtc)`.

**Step 5: Create migration and verify**
- `dotnet ef migrations add AddRoomSessionManagement`
- `dotnet test`

**Step 6: Commit**
- `git commit -m "feat: add room/session management schema"`

---

## Task 2: Add share-code generator and room lifecycle service

**Objective:** Create/join/find multiple rooms for same game.

**Files:**
- Create: `Services/RoomCodeGenerator.cs`
- Create: `Services/GamePlayRoomService.cs`
- Create: `Services/GamePlayRoomServiceModels.cs`
- Modify: `Program.cs` (DI)

**Step 1: Write failing tests**
- Code format: exactly 4 letters A-Z (no ambiguous set optional).
- Collision retry behavior.
- `CreateRoomAsync` allows multiple active rooms per same game/file.

**Step 2: Implement service**
- `CreateRoomAsync(gameId,fileId,creatorProfileId?,preferReuse:false)`:
  - Always creates new room record + new/reused Nosebleed runtime by `instanceKey = room:{roomId}` (unique runtime per room).
- `JoinRoomByCodeAsync(code,viewerId,profileId?)`:
  - Assign seat through `NosebleedSeatManager.Assign`.
  - Persist/update participant row.
- `GetRoomSnapshotAsync(roomId|code)`:
  - Include participants + watcher/player counts.

**Step 3: Verify tests pass**
- `dotnet test --filter RoomCodeGenerator|GamePlayRoomService`

**Step 4: Commit**
- `git commit -m "feat: add room lifecycle service with 4-letter codes"`

---

## Task 3: Enforce single active login per profile (newest wins)

**Objective:** One profile can only have one active auth session across tabs/devices.

**Files:**
- Modify: `Profiles/CurrentProfileService.cs`
- Modify: `Profiles/LocalProfileService.cs`
- Modify: `Controllers/ProfilesController.cs`
- Create: `Profiles/ProfileAuthSessionService.cs`
- Modify: `Program.cs`
- Create: `Middleware/ProfileSessionEnforcementMiddleware.cs`

**Step 1: Write failing tests**
- Sign-in creates `ProfileAuthSession` nonce cookie.
- Second sign-in revokes previous session.
- Requests from old nonce are forced signed-out/invalidated.

**Step 2: Implement**
- Add cookie `gv.profile_session` (GUID/nonce).
- On sign-in:
  - revoke existing active sessions for profile;
  - create new auth session row;
  - set profile cookie + session nonce cookie.
- Middleware checks each request:
  - if `gv.profile` present but session nonce revoked/missing => clear cookies and treat as signed-out.

**Step 3: Verify**
- Add integration test simulating two clients and takeover behavior.

**Step 4: Commit**
- `git commit -m "feat: enforce single active profile login session"`

---

## Task 4: Add join/create room UX and watcher fallback flow

**Objective:** Users choose existing room or create new; anonymous users can watch active room.

**Files:**
- Modify: `Controllers/GamesController.cs`
- Create: `Models/ViewModels/Room*ViewModel.cs`
- Modify: `Views/Games/PlayServer.cshtml`
- Create: `Views/Games/Rooms.cshtml` (or partials)
- Modify: route actions for `CreateRoom`, `JoinRoom`, `JoinByCode`

**Step 1: Write failing UI/controller tests**
- Game with active rooms shows list + create button.
- Join by invalid code fails with friendly message.
- Not logged-in user can open room as spectator.

**Step 2: Implement controller actions**
- `POST /Games/{id}/Rooms/Create`
- `POST /Games/{id}/Rooms/JoinExisting/{roomId}`
- `POST /Games/Rooms/JoinByCode`
- If anonymous and trying player action, redirect to `Profiles/Index` + invite/code guidance.

**Step 3: Implement Razor changes**
- “Create new session” / “Join existing” block.
- 4-letter share code display + copy button.
- Spectator banner when not authenticated.

**Step 4: Verify**
- Manual smoke: 2 browser profiles + one anonymous window.

**Step 5: Commit**
- `git commit -m "feat: add room create/join flows with spectator fallback"`

---

## Task 5: Presence and seat visibility

**Objective:** Show who is connected, player slots, and watcher count.

**Files:**
- Modify: `Nosebleed/NosebleedSeatManager.cs`
- Create: `Nosebleed/NosebleedSeatSnapshot.cs` (if needed)
- Modify: `Controllers/GamesController.cs`
- Modify: `Views/Games/PlayServer.cshtml`

**Step 1: Write failing tests**
- Seat manager can return per-session seat list snapshot.
- Presence API returns names + role + counts.

**Step 2: Implement**
- Add read method in seat manager: `GetAssignments(sessionId)`.
- Add endpoint `GET /Games/RoomPresence?roomId=...` returning:
  - player list (name/port/playerNumber)
  - watcherCount
  - totalConnected

**Step 3: Wire UI polling**
- Poll every 2–3 seconds (initially).

**Step 4: Commit**
- `git commit -m "feat: add room presence roster and watcher counts"`

---

## Task 6: Text chat (minimal viable)

**Objective:** Simple room chat tied to signed-in profile identity.

**Files:**
- Modify: `Controllers/GamesController.cs`
- Modify: `Services/GamePlayRoomService.cs`
- Create: `Models/ViewModels/RoomChat*ViewModel.cs`
- Modify: `Views/Games/PlayServer.cshtml`

**Step 1: Write failing tests**
- Signed-in user can post message.
- Anonymous user cannot post.
- Room message fetch returns latest N ordered ascending.

**Step 2: Implement endpoints**
- `GET /Games/RoomChat?roomId=...&since=...`
- `POST /Games/RoomChat` (anti-forgery, profile required)

**Step 3: UI**
- Text-only panel, max length (e.g., 280 chars), poll every 2s.

**Step 4: Commit**
- `git commit -m "feat: add minimal profile-bound room chat"`

---

## Task 7: Pruning policy for Nosebleed processes

**Objective:** Ensure non-arcade, inactive rooms do not leak processes.

**Files:**
- Modify: `Nosebleed/NosebleedSessionManager.cs`
- Modify: `Services/GamePlayRoomService.cs`
- Modify: `Controllers/HomeController.cs` (ops visibility)
- Optional: create hosted service `Services/RoomPrunerHostedService.cs`

**Step 1: Write failing tests**
- Room with no participants for TTL is closed.
- Corresponding Nosebleed session is stopped unless arcade-bound active cabinet.

**Step 2: Implement pruning**
- Criteria:
  - no connected participants for `RoomIdleTimeoutMinutes`
  - not arcade-bound active
- Mark room closed + stop session via `TryStop(sessionId, "idle-prune")`.

**Step 3: Verify**
- Manual: start room, disconnect all, wait timeout, confirm process gone and room closed.

**Step 4: Commit**
- `git commit -m "feat: prune idle non-arcade nosebleed room sessions"`

---

## Task 8: Security, abuse limits, and regression tests

**Objective:** Keep auth/session transitions safe and avoid easy spam.

**Files:**
- Modify: `Controllers/GamesController.cs`
- Modify: existing test project files
- Optional: `Services/RateLimitService.cs`

**Step 1: Add negative tests**
- Tampered room code / session id cannot escalate to input.
- Revoked profile session cannot post chat.
- Anonymous cannot obtain player token.

**Step 2: Add guardrails**
- Chat rate limit per profile (e.g., 1 msg/sec, burst 5).
- Message sanitization/encoding (Razor auto-encodes; keep plain text only).

**Step 3: Full verification**
- `dotnet build`
- `dotnet test --no-build`

**Step 4: Commit**
- `git commit -m "test: add room/session security and regression coverage"`

---

## API/Route additions (planned)

- `POST /Games/{gameId}/Rooms/Create`
- `POST /Games/{gameId}/Rooms/JoinExisting/{roomId}`
- `POST /Games/Rooms/JoinByCode`
- `GET /Games/RoomPresence?roomId={id}`
- `GET /Games/RoomChat?roomId={id}&since={ticks?}`
- `POST /Games/RoomChat`

---

## Acceptance Criteria

1. Same game can have multiple active rooms concurrently.
2. Every room has a unique 4-letter code users can share.
3. Unauthenticated users can spectate existing room AV.
4. Control/input only available when policy allows and seat role=player.
5. Profile login is single-active-session: newest login takes over, old tabs/devices are signed out.
6. Room UI shows connected named players and watcher counts.
7. Room chat works for signed-in users and is visible to all room viewers.
8. Orphan/idle non-arcade Nosebleed processes are automatically pruned.
9. Existing arcade flows still work.

---

## Manual test matrix (minimum)

1. **Create two rooms same game** from two signed-in profiles → both active, different codes.
2. **Anonymous join by code** → watch AV, no input access.
3. **Signed-in join same room** → gets player seat if free else spectator.
4. **Two-tab same profile** → second tab login revokes first; first loses ability to act.
5. **Phone + desktop same profile** → newest retains session; older gets signed out on next request.
6. **Chat** → signed-in post visible to others; anonymous cannot post.
7. **Prune** → room empties, timeout hits, process stopped unless arcade-bound.

---

## Rollout strategy

- Feature flag initially: `SessionRooms:Enabled`.
- Deploy to VAULT (dev), run matrix above.
- Promote to VPS/prod via existing `scripts/deploy-prod-from-main.sh` flow.
- Post-deploy monitor: active room count, prune events, auth-session revocations, 502 proxy errors.

---

## Suggested first PR slice

To reduce risk, implement in three PRs:
1. Schema + room lifecycle services + create/join by code.
2. Single-active-login enforcement + presence.
3. Chat + pruning + hardening tests.

This keeps each reviewable and lets you dogfood quickly.
