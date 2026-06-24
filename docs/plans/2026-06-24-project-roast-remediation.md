# Games Vault Project Roast Remediation Plan

> **For Hermes:** Use `subagent-driven-development` when executing broad refactors. For lifecycle/security/data changes, use TDD and verify against a real Postgres database plus live deployment checks.

**Goal:** Turn the current Games Vault architecture roast into an implementation roadmap that makes state lifecycle honest, deploys deterministic, cleanup explicit, tests database-backed, and the codebase smaller.

**Architecture:** Keep the existing split — `gv-web` owns auth/DB/command queue, `gv-server` owns local processes/filesystem, `gv-worker` owns runtime/WebRTC — but make lifecycle boundaries explicit. Durable DB state must be generation-scoped and reconciled with process/worker truth. Deployment and cleanup must become explicit scripts/jobs instead of implicit startup side effects.

**Tech Stack:** Next.js 15 + Drizzle/Postgres (`gv-web`), Rust (`gv-server`, `gv-worker`, `libretro-runner`), systemd on VAULT, Docker Compose on VPS, GitHub Issues for tracking.

---

## Current state verified on 2026-06-24

- Open fast-connect/lifecycle issues already exist: #474, #475, #476, #477.
- Dashboard false “open sessions” was fixed in `111ec00` and cleanup FK ordering/startup schema-push noise was fixed in `15c0528`.
- Live DB currently reports `0` open sessions and VAULT has no `gv-worker` processes/PID files.
- Remaining problems are architectural/hygiene issues, not the specific dashboard count bug.

## Dependency map

```text
#477 generation-scoped sessions
  └─ blocks: safest SDP/session invalidation and stale-offer rejection

#474 launch timeline instrumentation
  └─ feeds: dashboard launch trace / ops console issue

#475 worker HTTP/SDP before ROM/core load
#476 warm no-ROM worker pool
  └─ depend on: #474 enough instrumentation to measure wins

New issues from this plan:
  A. One blessed deploy script + runtime version stamping
  B. Explicit migrations discipline
  C. Move gv-web cleanup out of import side effect
  D. Postgres integration test harness for lifecycle/FK cleanup
  E. Dashboard ops console: reconcile DB sessions, commands, workers, launch events
  F. Build hygiene: install/configure ESLint or intentionally disable lint step
  G. Codebase comprehension pass: finish god-file splits and remove stale plan
```

---

## Phase 1 — Stop production surprises

### Task 1: Create one blessed gv-web deploy script

**Objective:** Replace ad-hoc tar commands with one repeatable script that deploys the exact runtime root the container actually executes.

**Files:**
- Create: `scripts/deploy-gv-web.sh`
- Modify: `docs/RELEASE.md` or create it if missing
- Verify live: VPS container `gv-web-gv-web-1`

**Implementation notes:**
1. Run `npm run build` in `gv-web/`.
2. Pack `.next/standalone/gv-web/.` into the runtime root, not `.next/standalone/` itself.
3. Include `.next/static`, `public`, `package.json`.
4. Copy/extract to `/app/gv-web/` in the running container.
5. Patch/copy `/entrypoint.sh` if needed until the Docker image is rebuilt.
6. Restart `gv-web-gv-web-1`.
7. Verify `/api/health` and verify running bundle contains the expected git SHA/version stamp.

**Acceptance criteria:**
- One command deploys gv-web.
- The script fails if git is dirty unless `--allow-dirty` is passed.
- The script prints the deployed git SHA and verifies the same SHA from a live endpoint or generated runtime file.
- No schema push runs during normal production startup.

### Task 2: Add explicit migration workflow

**Objective:** Make DB migrations explicit and non-interactive.

**Files:**
- Create/modify: `scripts/apply-gv-web-migration.sh`
- Modify: `docs/RELEASE.md`
- Keep: `docker/gv-web/entrypoint.prod.sh` default `GV_WEB_SCHEMA_PUSH_ON_START=0`

**Implementation notes:**
1. Document: generate migration, review SQL, apply SQL to VPS Postgres, deploy app.
2. The apply script accepts a migration filename under `gv-web/drizzle/*.sql`.
3. It runs `psql -v ON_ERROR_STOP=1` inside `gv-web-postgres-1`.
4. It verifies the expected table/columns exist when the migration includes schema changes.

**Acceptance criteria:**
- Production restarts never invoke `drizzle-kit push` unless explicitly opted in.
- Migration application is a separate command and fails on SQL errors.
- Release docs show exact migration/deploy order.

---

## Phase 2 — Make lifecycle truth explicit

### Task 3: Finish generation-scoped sessions (#477)

**Objective:** Ensure stale SDP/offers cannot route to old workers or old DB rows.

**Files likely touched:**
- `gv-web/lib/db/schema.ts`
- `gv-web/app/api/server/command/route.ts`
- `gv-web/app/api/server/notify/route.ts`
- `gv-web/app/api/worker-proxy/[game_id]/route.ts`
- `gv-server/src/gv_web.rs`
- `gv-server/src/poller.rs` / command handlers

**Acceptance criteria:**
- Each launch/session has a generation identifier.
- `start_game`, `sdp_offer`, `notify`, and worker proxy paths validate generation/session match.
- Starting a new game invalidates older generations deterministically.
- Tests prove old SDP offers are rejected after a new generation starts.

### Task 4: Finish launch timeline instrumentation (#474)

**Objective:** Record enough milestones to explain slow or failed launches without spelunking logs.

**Milestones:**
- `command_inserted` (done)
- `command_leased` (done)
- `worker_spawn_requested`
- `worker_process_started`
- `worker_http_ready`
- `rom_load_started`
- `rom_load_finished`
- `sdp_offer_sent`
- `sdp_answer_returned`
- `ice_connected`
- `data_channel_open`
- `first_frame`

**Acceptance criteria:**
- A single launch trace can be queried by session/command ID.
- Sensitive fields are excluded: no tokens, bearer headers, SDP blobs, ROM paths beyond basename unless already user-visible.
- Dashboard can display ordered timeline rows.

### Task 5: Create a dashboard ops console view

**Objective:** Replace guessy status cards with a reconciled operational view.

**Files:**
- `gv-web/app/dashboard/page.tsx`
- possibly new `gv-web/app/dashboard/LaunchTracePanel.tsx`
- possibly new `gv-web/app/api/admin/runtime-state/route.ts`

**Implementation notes:**
1. Show DB session counts separately from live worker/process truth.
2. Show command queue state: pending, leased, failed, completed.
3. Show latest launch timeline for active/recent sessions.
4. If live process inventory is unavailable to gv-web, report that explicitly rather than guessing.

**Acceptance criteria:**
- Dashboard labels never call DB rows “workers”.
- Stale rows are visible as stale rows.
- Recent launch trace is visible from the dashboard.
- There is a documented source-of-truth table for each displayed field.

---

## Phase 3 — Make cleanup and tests real

### Task 6: Move gv-web cleanup out of import side effect

**Objective:** Stop cleanup from depending on Next module import timing.

**Files:**
- `gv-web/lib/db/cleanup.ts`
- Create: `gv-web/scripts/cleanup.ts` or `scripts/gv-web-cleanup.sh`
- Deployment: systemd timer, cron, or explicit container sidecar command

**Implementation notes:**
1. Export `cleanupOnce()` without auto-starting at import time.
2. Add a script entry point that runs cleanup once and exits.
3. Run it on a schedule via cron/systemd/docker compose, not per web process import.
4. Keep the current FK-safe cleanup order.

**Acceptance criteria:**
- Importing `gv-web` modules does not start a cleanup interval.
- Cleanup can be run manually and exits 0.
- Scheduled cleanup runs exactly once per interval in production.
- Tests prove FK cleanup order works.

### Task 7: Add Postgres-backed integration tests for lifecycle and cleanup

**Objective:** Catch the class of bugs mocks missed: FK ordering, state transitions, lease expiry, stale session cleanup.

**Files:**
- Create: `gv-web/tests/integration/lifecycle-db.test.ts`
- Create: `gv-web/tests/integration/cleanup-db.test.ts`
- Modify test scripts in `gv-web/package.json` if needed

**Implementation notes:**
1. Use a disposable Postgres database/container.
2. Apply migrations before tests.
3. Test start/poll/notify/result/cleanup flows against real SQL.
4. Keep route unit tests for validation, but do not rely on mocked Drizzle chains for DB invariants.

**Acceptance criteria:**
- Integration test suite fails on FK cleanup ordering bugs.
- Integration test suite proves stale sessions become `timed_out`.
- CI/local command is documented.

---

## Phase 4 — Product feel and code hygiene

### Task 8: Fast connect runtime changes (#475 and #476)

**Objective:** Reduce launch wait by making worker networking ready before heavy ROM/core work and by keeping a warm no-ROM worker pool.

**Acceptance criteria:**
- #475: gv-worker accepts HTTP/SDP before ROM/core load finishes.
- #476: gv-server maintains a single-use warm no-ROM pool.
- #474 timeline shows before/after launch latency improvement.

### Task 9: Build hygiene — fix lint warning policy

**Objective:** Stop training humans to ignore build output.

**Files:**
- `gv-web/package.json`
- optional: `eslint.config.mjs`
- optional: `next.config.ts`

**Implementation notes:**
1. Either install/configure ESLint properly or intentionally configure Next to skip lint during build.
2. The chosen approach must be documented.
3. The build output should not contain the recurring “ESLint must be installed” warning.

**Acceptance criteria:**
- `npm run build` has no ESLint missing warning.
- `npx tsc --noEmit` passes.
- If lint is enabled, `npm run lint` passes.

### Task 10: Codebase comprehension pass

**Objective:** Finish the “pretty, small, easy to comprehend” work without repeating the stale 2025 plan mistakes.

**Files likely touched:**
- `gv-web/app/dashboard/page.tsx`
- `gv-web/app/dashboard/DashboardClient.tsx`
- `gv-web/app/dashboard/ServerPanel.tsx`
- `gv-web/components/GamePlayer.tsx`
- `gv-web/components/LibraryClient.tsx`
- Rust god files identified by `pygount`/line count
- Stale doc: `docs/plans/2025-06-24_code-quality-cleanup.md`

**Implementation notes:**
1. Start with a fresh inventory of large files and clippy/tsc warnings.
2. Do not trust the stale 2025 plan’s dead-code claims without checking `--lib` and `--bin`.
3. Extract one component/module at a time.
4. Run `npx tsc --noEmit` or `cargo test -p <crate>` after each extraction.

**Acceptance criteria:**
- No duplicated dashboard dev tools JSX remains.
- No target god file remains above the agreed line threshold unless documented.
- Stale 2025 plan is replaced/marked obsolete.
- Typecheck/build/tests pass.

---

## Issue mapping

Existing issues retained:
- #474 — launch timeline instrumentation
- #475 — worker HTTP/SDP before ROM/core load
- #476 — warm no-ROM worker pool
- #477 — generation-scoped sessions/stale SDP rejection

Umbrella issue:
- #487 — Epic: project roast remediation roadmap

New issues created:
- #480 — Blessed gv-web deploy script + runtime version stamping
- #481 — Explicit gv-web migration workflow
- #482 — Move cleanup out of import side effect
- #483 — Postgres-backed lifecycle/cleanup integration tests
- #484 — Dashboard ops console / launch trace reconciliation
- #485 — Build hygiene: ESLint warning policy
- #486 — Codebase comprehension pass / finish god-file splits

## Verification standard for all issues

Every implementation issue must include:
- exact files touched
- local command verification
- live-system verification when deployment/runtime behavior is involved
- no warnings/errors left behind
- issue close comment with commit SHA after completion
