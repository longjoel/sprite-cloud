# Games Vault — Critical Code Review Report

**Date:** 2026-06-12
**Scope:** Full codebase (`Controllers/`, `Profiles/`, `Web/`, `Nosebleed/`, `Gameplay/`, `Arcade/`, `Data/`, `Models/`, `Views/`, `Services/`, `BackgroundJobs/`)
**Audited by:** 3 parallel subagents (security + data layer + streaming/runtime)
**Excluded:** Tests, `bin/`, `obj/`, `publish/`, `node_modules/`, `wwwroot/lib/`

---

## Severity Tally

| Severity | Count |
|----------|-------|
| **CRITICAL** | 11 |
| **HIGH** | 25 |
| **MEDIUM** | 32 |
| **LOW** | 25 |

---

## [CRITICAL] Findings

### Security & Auth

#### C1 — Unauthenticated ROM File Download
**`Controllers/GamesController.cs:666-721`** — `Rom(int id)` serves ROM bytes with zero authorization. Auto-increment IDs, trivially enumerable. No `CanPlay` or `AdminOnly` check.
→ Add `currentAccess.CanPlayAsync(cancellationToken)` check.

#### C2 — Auth Cookie `Secure` Flag Missing Behind Proxy
**`Profiles/CurrentProfileService.cs:169`** — `Secure = http.Request.IsHttps` is false behind Nginx without `UseForwardedHeaders()`. Auth cookies travel cleartext between proxy and Kestrel.
→ Add `app.UseForwardedHeaders()` in `Program.cs`, or hardcode `Secure = true`.

### Data Layer

#### C3 — Per-Row `SaveChangesAsync` in `GameArtBackfillCommand`
**`BackgroundJobs/Commands/GameArtBackfillCommand.cs:134`** — Up to 500 individual `SaveChangesAsync` calls inside a loop. Each also triggers log entry saves.
→ Batch every N iterations, or save once after the loop.

#### C4 — Per-Row `SaveChangesAsync` in `GameArtBackfillService`
**`Services/GameArtBackfillService.cs:101`** — Identical pattern. Near-duplicate of the command.
→ Fix, or remove the service entirely since the command duplicates it.

#### C5 — Unbounded `.ToListAsync()` in `GamePlayTelemetryService`
**`Gameplay/GamePlayTelemetryService.cs:146`** — `GetDashboardStatsAsync` loads ALL sessions into memory with no limit. OOM risk with large DB.
→ Push GroupBy/aggregation into the EF query.

#### C6 — Unbounded Home Page Session Query
**`Controllers/HomeController.cs:66-82`** — Loads all sessions from last 90 days just to `.Take(8)` in memory.
→ Add `.OrderByDescending().Take(50)` to the DB query.

### Streaming & Runtime

#### C7 — Process Handle Leak on Health Check Failure
**`Nosebleed/NosebleedSessionManager.cs:584-587`** — `TryKill(process)` called without `process.Dispose()`. Every other kill site pairs them correctly.
→ Add `process.Dispose()` after `TryKill`.

#### C8 — Sync-Over-Async Deadlock in `Dispose()`
**`Nosebleed/NosebleedSessionManager.cs:800`** — `ShutdownAsync().GetAwaiter().GetResult()` blocks on finalizer/shutdown thread. If any process is zombie, teardown hangs forever.
→ Use `.Wait(TimeSpan.FromSeconds(10))` or fire-and-forget with timeout.

#### C9 — WebSocket Relay Writer-Death Deadlocks Reader
**`Nosebleed/NosebleedWebSocketRelay.cs:124-125`** — Sequential `await reader; await writer;` — if writer throws first, reader blocks on full channel forever. `await writer` is never reached.
→ Use `Task.WhenAll(reader, writer)` with linked cancellation.

#### C10 — `AllocatePort` Crashes on Disposed Process
**`Nosebleed/NosebleedSessionManager.cs:640`** — Uses raw `.HasExited` instead of `SafeHasExited()`. Throws on disposed Process objects.
→ Replace with `SafeHasExited()`.

#### C11 — Per-Row `SaveChangesAsync` in Log Entries
**`BackgroundJobs/BackgroundJobExecutionContext.cs:78`** — Each `LogInfoAsync`/`LogWarnAsync` triggers `SaveChangesAsync`. Art backfill with 500 games = 500-1000 extra round-trips.
→ Buffer log entries and flush periodically.

---

## [HIGH] Findings — Top Issues

### Auth & Security

| # | File:Line | Issue |
|---|-----------|-------|
| H1 | `ProfilesController.cs:130-137` | Open redirect: `Uri.TryCreate(//evil.com, UriKind.Relative)` passes. Use `Url.IsLocalUrl()` |
| H2 | `SessionController.cs:640,670`, `ArcadeController.cs:615` | Viewer cookie missing `HttpOnly=true` at 3 creation sites |
| H3 | `ProfilesController.cs:73` | No `[RateLimit]` on profile creation POST |
| H4 | `SessionController.cs:36` | No IP rate limit on share link redemption |
| H5 | `GameFilesController.cs:72-74` | External path served without LocalFolders containment check |

### Data Layer

| # | File:Line | Issue |
|---|-----------|-------|
| H6 | `ArcadeController.cs:505` | N+1: `db.ArcadeCabinets.Count(c => c.GameId == g.Id)` in Select projection |
| H7 | `GamesController.cs:358-366` | N+1: Correlated subqueries in OrderBy (RecentlyPlayed, MostPlayed) |
| H8 | `ProfilesController.cs:391, 433` | Unbounded `.ToListAsync()` for profile sessions — filter in DB |
| H9 | `ProfilesController.cs:25, 28` | Admin loads all profiles + all sessions with no pagination/date filter |
| H10 | `HomeController.cs:42-125` | 5+ sequential DB round-trips on home page — can parallelize |
| H11 | `GamesController.cs:197-199` | Loads all NetworkShares/WebSources/LocalFolders on every games page |
| H12 | `ArcadeCabinet` (model) | No concurrency token — modified by supervisor + web requests concurrently |
| H13 | `GamePlayRoom` (model) | No concurrency token — modified by multiple paths |
| H14 | Game cascade configs | `DeleteBehavior.Cascade` on Game→GamePlayRoom→ChatMessages etc. — bulk game delete triggers mass data loss |
| H15 | `GameArtBackfillCommand.cs` + `Service` | Multiple `SaveChangesAsync` without wrapping transaction |

### Streaming & Runtime

| # | File:Line | Issue |
|---|-----------|-------|
| H16 | `SessionManager.cs:683-695` | `CleanupExitedSessions` iterates without lock — races with StartAsync |
| H17 | `SessionManager.cs:94-104` | `TryRequestResetAsync` uses raw `.HasExited`, iterates without lock |
| H18 | `SessionManager.cs:310` | `ReconcileOrphansAsync` writes to `_sessions` without lock |
| H19 | `GamePlayRoomService.cs:570-616` | Double-stop race in `CloseStandaloneRoomAsync` |
| H20 | `GamePlayRoomService.cs:304-331` | TOCTOU: seat release then stale read of active player count |
| H21 | `BatterySaveRuntimeSyncService.cs:41-44` | Deletes active runtime save directory during live game reset |
| H22 | `SessionController.cs:396-397` | Video channel uses `PumpOrderedAsync` — should use `PumpLatestOnlyAsync` |
| H23 | `WebSocketRelay.cs:127-133` | CloseAsync race: destination state check then throw on state change |
| H24 | `SessionController.cs:382-392` | Upstream WS connect failure — ClientWebSocket.Dispose may throw |
| H25 | `SessionController.cs:506-508` | `ReadToEndAsync` on upstream response — no size cap |

---

## Top 10 Fixes by Blast Radius

1. **C1** — Add auth to `GamesController.Rom` (entire ROM library exposed)
2. **C2** — Fix `Secure` cookie flag behind proxy (auth token cleartext)
3. **C7** — Process handle leak on health check failure (FD exhaustion)
4. **C9** — WebSocket relay deadlock (streaming hangs)
5. **C8** — Dispose() deadlock (service restart hangs)
6. **C10** — AllocatePort crash on disposed process (session start failures)
7. **H1** — Open redirect bypass (phishing vector)
8. **C3/C4** — Per-row SaveChanges in art backfill (DB overload)
9. **H19** — Double-stop race in room cleanup (exceptions, data corruption)
10. **H21** — Save directory deletion during live game (player data loss)

---

## Remediation Priority by Area

### Immediate (this week)
1. Fix C1 (ROM auth) — one `if` check
2. Fix H1 (open redirect) — swap `Uri.TryCreate` for `Url.IsLocalUrl`
3. Fix H2 (HttpOnly cookies) — add `HttpOnly = true` at 3 sites
4. Fix C7 (process leak) — add `process.Dispose()` on line 587
5. Fix C10 (disposed Process crash) — use `SafeHasExited()` on line 640
6. Fix H21 (save dir deletion) — don't delete while game is running

### Short-term (next 2 weeks)
7. Fix C3/C4 (batch SaveChanges in art backfill)
8. Fix C9 (WebSocket relay deadlock) — `Task.WhenAll`
9. Fix C8 (Dispose deadlock) — timeout on ShutdownAsync
10. Fix H6/H7 (N+1 queries in game browsing)
11. Fix C5 (unbounded telemetry query)
12. Add concurrency tokens to ArcadeCabinet and GamePlayRoom (H12, H13)

### Medium-term
13. Configure `UseForwardedHeaders()` in Program.cs (fixes C2 + H3 rate limiting)
14. Fix H19 (room double-stop race)
15. Fix H22 (video channel relay mode)
16. Fix H14 (cascade delete chains — consider `DeleteBehavior.Restrict`)
17. Fix C11 (log entry batching)

### Deferred / Low Priority
18. Remove duplicate `GameArtBackfillService` or unify with command
19. Add composite indexes for game browsing queries
20. Add indexes on `GamePlaySession.EndedUtc`, `NetworkShare.Enabled`, etc.
