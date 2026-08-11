# Session Readiness and Resident Recovery Remediation Plan

> **For Hermes:** Execute this plan task-by-task with tests before implementation and independent production verification after merge.

**Goal:** Make database session state a recoverable coordination record rather than a stale authority that can block or duplicate live game runtimes after sc-server restarts.

**Architecture:** Keep the `spawning → ready → connected → playing → ended/timed_out` state machine, but bind active sessions to a host boot generation and require explicit reconciliation after restart. Move resident convergence out of the latency-critical poll response, make command/session creation atomic, and enforce one runtime per server/game. Preserve launch telemetry and fail closed when the database and runtime disagree.

**Tech Stack:** Next.js route handlers, Drizzle/PostgreSQL, Rust `sc-server`, systemd, Vitest, integration tests.

---

## Incident evidence and current state

Observed on 2026-08-10:

- `sc-server` had four duplicate `sc-core` processes for the same Metal Slug runtime identifiers.
- The gateway retained a stale `ready` session after `sc-server` restarted.
- Restart removed the orphaned processes, but the stale `ready` row prevented resident recreation.
- Manual stale-session cleanup caused resident convergence to create a new start command.
- The fresh resident start successfully launched the core and GStreamer pipeline, but `/api/server/notify` returned HTTP 409: `session does not match callback command`.
- Resident convergence then re-leased/restarted the same game approximately every 30 seconds.
- The immediate mitigation disabled `always_on` for Metal Slug, stopped `sc-server`, cancelled the stale command, and restarted `sc-server` with no active `sc-core`.
- TURN remained healthy throughout: startup reported `turn_ready`, prewarm succeeded, and `/api/health` reported a relayed allocation.

Current production mitigation:

- Metal Slug `always_on` is temporarily `false`.
- The stale sessions were transitioned to `timed_out`, not deleted.
- The duplicate resident command was cancelled.
- `sc-server` is active with no `sc-core` child.

Do not re-enable `always_on` until the resident-session tests and production canary gates below pass.

## Invariants

1. At most one active database session exists per `(server_id, game_id, generation)`.
2. At most one live runtime/core exists per `(server_id, game_id)`.
3. A `ready` row is not proof of a live runtime; it is valid only for the current server boot generation and heartbeat window.
4. A server restart must invalidate or reconcile its prior active sessions before accepting guest SDP.
5. Resident convergence must never create a second `start_game` while a matching start is pending, leased, or being reconciled.
6. `notify_ready` must be idempotent for the exact command/session pair and must reject mismatches without leaving a runnable orphan.
7. Poll responses must not wait on resident reconciliation or diagnostic writes that can delay command delivery.
8. Session history and launch telemetry remain queryable after cleanup; cleanup transitions stale rows before retention deletion.

---

## Task 1: Add a regression fixture for restart-stale readiness

**Objective:** Reproduce the current split-brain state in an integration test before changing behavior.

**Files:**
- Modify: `sc-web/tests/integration/lifecycle-db.test.ts`
- Test helpers: existing test database fixture

**Steps:**
1. Create a session in `ready` with a known `server_id`, `game_id`, and command ID.
2. Simulate a new server boot identity without creating a matching runtime.
3. Assert the current behavior is captured as a failing regression expectation: the stale session is currently considered active.
4. Run `pnpm test -- tests/integration/lifecycle-db.test.ts`.
5. Commit the test-only red state.

**Acceptance:** The test demonstrates exactly why a post-restart `ready` row can suppress a fresh start.

## Task 2: Add server boot generation to server/session state

**Objective:** Bind active session validity to the sc-server process generation.

**Files:**
- Modify: `sc-web/lib/db/schema.ts`
- Modify: `sc-web/lib/constants.ts`
- Add targeted migration under: `sc-web/drizzle/`
- Tests: `sc-web/tests/integration/lifecycle-db.test.ts`

**Steps:**
1. Add a server boot-generation value or equivalent runtime identity to the server heartbeat/session contract.
2. Store the generation on each new session.
3. Require active-session queries used by launch, join, wall, and resident convergence to match the current server generation.
4. Add the migration using the repository's existing migration workflow; inspect generated SQL before applying.
5. Run the lifecycle tests and migration checks.

**Acceptance:** A session from a previous server generation cannot suppress a new launch or accept guest SDP.

## Task 3: Reconcile active sessions during sc-server startup

**Objective:** Make restart cleanup explicit and automatic instead of relying on a manual database operation.

**Files:**
- Modify: `sc-server/src/main.rs` or startup command module
- Modify: `sc-server/src/commands/game.rs` or existing web client module
- Modify: `sc-web/app/api/server/notify/route.ts` or add a dedicated reconciliation route
- Tests: `sc-web/tests/api/routes.test.ts`; Rust startup/notify tests if present

**Steps:**
1. Emit a server-boot/reconcile notification containing only the server identity and new generation; never include credentials in telemetry.
2. Transition prior-generation active sessions for that server to `timed_out` with `ended_at`.
3. Ensure reconciliation is idempotent and safe if the server retries after a network timeout.
4. Verify that a second boot notification does not create duplicate rows or commands.
5. Run focused API/Rust tests.

**Acceptance:** Restarting sc-server invalidates stale active rows before the next guest join or resident decision.

## Task 4: Make resident start command and session creation atomic

**Objective:** Eliminate the `notify` 409 caused by a resident start command whose payload session ID has no matching database session.

**Files:**
- Modify: `sc-web/app/api/server/poll/route.ts`
- Modify: `sc-web/app/api/server/command/route.ts`
- Modify: `sc-web/app/api/server/notify/route.ts`
- Tests: `sc-web/tests/api/routes.test.ts`

**Steps:**
1. Trace the exact resident `start_game` path from `convergeResidents()` through poll, sc-server, and `notify_ready`.
2. Create the database session row in the same transaction as the resident start command, or remove the synthetic session ID until the notify route creates the row atomically.
3. Enforce exact `(command_id, session_id, server_id, game_id)` matching.
4. Make repeated `notify_ready` for the same exact pair return the existing successful state rather than 409.
5. Add negative tests for mismatched command/session IDs and positive tests for retry/idempotency.
6. Run `pnpm test -- tests/api/routes.test.ts`.

**Acceptance:** A resident start either creates one matching session and reaches `ready`, or fails terminally without leaving a core that convergence will restart.

## Task 5: Remove resident convergence from the synchronous poll critical path

**Objective:** Ensure command delivery cannot stall behind reconciliation work.

**Files:**
- Modify: `sc-web/app/api/server/poll/route.ts`
- Add: a convergence worker/job module using the repository's existing server-side scheduling pattern
- Tests: new `sc-web/tests/api/server-poll.test.ts` or existing poll coverage

**Steps:**
1. Make `/api/server/poll` perform only authentication, bounded command leasing, and response serialization.
2. Schedule resident convergence independently with a single-flight guard per server.
3. Add a timeout and error telemetry around convergence; failures must not block ordinary commands.
4. Add a poll latency test with a deliberately delayed convergence dependency.
5. Verify SDP commands are returned within the normal poll budget while convergence is delayed.

**Acceptance:** Poll responses remain fast and command leasing continues when resident reconciliation is slow or failing.

## Task 6: Enforce one runtime per server/game

**Objective:** Prevent duplicate `sc-core` processes even when commands are retried or notify calls time out.

**Files:**
- Modify: `sc-server/src/commands/game.rs`
- Modify: runtime session registry/process supervisor module
- Tests: Rust session lifecycle tests and integration coverage

**Steps:**
1. Add an authoritative runtime key `(server_id, game_id)` in the in-memory registry.
2. Before spawning, atomically claim the runtime key; return/reconcile an existing matching runtime instead of spawning another.
3. On core startup failure, child exit, notify failure, and shutdown, release the key and terminate the child process.
4. Add tests for concurrent duplicate `start_game` commands, notify timeout retries, and restart cleanup.
5. Verify process counts during a local canary.

**Acceptance:** Repeated or concurrent starts produce at most one `sc-core` process per game.

## Task 7: Make stale-session cleanup continuous and resident-aware

**Objective:** Ensure the existing 60-second timeout policy actually runs in production.

**Files:**
- Modify: `sc-web/lib/db/cleanup.ts` only if policy changes are required
- Modify: `sc-web/scripts/cleanup.ts` if scheduling/exit behavior needs hardening
- Modify: deployment/systemd/cron configuration where the cleanup job is defined
- Tests: `sc-web/tests/integration/cleanup-db.test.ts`

**Steps:**
1. Verify the production scheduler invokes `pnpm run cleanup:once`; do not assume module import starts it.
2. Add an explicit health/metric for cleanup execution and last successful run.
3. Keep active resident sessions from being timed out solely because they are resident; require generation/heartbeat validation instead.
4. Preserve ended/timed-out rows for launch-history retention before deletion.
5. Test stale `spawning`, `ready`, and `connected` rows and resident rows separately.

**Acceptance:** Cleanup runs continuously, stale nonresident rows time out, and resident rows cannot remain falsely active across a server restart.

## Task 8: Add observability for session/runtime divergence

**Objective:** Make the next incident diagnosable without correlating raw logs manually.

**Files:**
- Modify: `sc-web/lib/launch-events.ts`
- Modify: `sc-web/app/api/server/notify/route.ts`
- Modify: `sc-web/app/api/server/poll/route.ts`
- Modify: `sc-server/src/commands/game.rs`
- Tests: launch-event/API tests

**Steps:**
1. Emit structured events for boot generation, session reconciliation, runtime claim/release, duplicate-start suppression, notify mismatch, and poll latency.
2. Record IDs and state only; never record bearer tokens, passwords, SDP blobs, or connection credentials.
3. Add a diagnostic query/dashboard for active DB sessions versus runtime claims.
4. Add an alert when active DB sessions exist without a matching heartbeat/runtime claim.

**Acceptance:** A restart mismatch identifies the exact server generation, session ID, command ID, and reconciliation decision without secrets.

## Task 9: Controlled canary and re-enable resident Metal Slug

**Objective:** Restore the user-visible resident game only after the lifecycle contract is verified.

**Steps:**
1. Deploy the web and server changes through the normal PR/CI path; do not copy binaries directly to production.
2. Confirm migration status and backup/rollback procedure.
3. Start sc-server once and verify one boot generation, one resident session, and one core.
4. Test host launch, guest join, wall preview, stop/restart, and server restart.
5. Confirm no duplicate `sc-core`, no repeated `notify` 409s, no leased-command loop, and stable poll latency.
6. Re-enable Metal Slug `always_on` only after all gates pass.
7. Monitor for at least one resident convergence interval before declaring success.

**Acceptance:** Metal Slug streams through host, guest, and wall-preview flows; restart recovery produces one fresh session without manual SQL cleanup.

---

## Immediate production state after incident cleanup

- Metal Slug `always_on`: temporarily disabled.
- Stale active sessions: transitioned to `timed_out`.
- Duplicate resident start command: cancelled/terminal.
- sc-server: active after restart.
- sc-core processes: none running.
- TURN: healthy and relay-capable.

Re-enable resident mode only through Task 9's canary procedure.
