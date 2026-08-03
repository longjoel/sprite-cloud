# L2 E2E + Accounts-Required — Design (#662 slice 3 + #745)

**Status:** proposed · **Owner:** Hermes + Joel · **Milestone:** Sept beta

## 1. Why these ship together

#745 (accounts-required for local play) changes the *entry point* of the
exact flow L2 is meant to test. Building L2 against today's anonymous LAN
page would test a flow we're deleting. Building the auth gate without an E2E
harness to prove it would leave the hardest part (redirect → login →
capability → play) untested. So: design L2 around the auth-gated flow once.

The decisive requirement (Joel, 2026-08-03): **tests must fabricate users
and exercise *different users against each other*** — because the whole point
of accounts is that player A's saves/states/play-time are visible to A and
not B. A single-user harness cannot prove that.

## 2. Target flow (what the browser walks)

```
browser → http://<server>:8787            (direct hit, no session)
   └─ server responds: auth-gate page      (no more anonymous library)
        ├─ "Download the app"  (future)     → placeholder link
        └─ "Sign in at your gateway"        → redirect to <gateway>/signin?next=...
gateway login (NextAuth credentials + bcrypt)
   └─ gateway redirects back with capability/session
server player page (authenticated)
   └─ WebRTC → nestopia → counter.nes
artifacts keyed to (account_id, rom_hash)
```

## 3. Test topology (one host, three processes)

```
┌─ Playwright (headless Chrome, H.264)
│    │
│    ▼
┌─ sc-web (Next.js) ──────────────┐
│  port 3000 · Postgres (docker)  │
│  auth · short codes · resolves  │
└──────────────┬──────────────────┘
               │ http
┌──────────────▼──────────────────┐
│ sc-server (paired, not standalone) │
│  port 8787 · nestopia · saves   │
└─────────────────────────────────┘
```

Reuses: `sc-web/tests/integration/test-db.ts` (disposable Postgres) for the
gateway DB; `e2e/l1/run-l1.sh` bones for server bring-up; the same
Playwright + Chrome config for the browser.

## 4. User fabrication — the core new machinery

All tests need **known users with known credentials** in the gateway DB.
Because auth is NextAuth-credentials + bcrypt (no OAuth provider), tests can
insert users directly:

```ts
// e2e/l2/lib/fabricate.ts
export async function fabricateUser(db, { email, name, role = "member" }) {
  const passwordHash = await bcrypt.hash(PASSWORD, 10);   // same cost as prod
  const user = await db.insert(users).values({ email, name, passwordHash }).returning();
  return { ...user, password: PASSWORD };                   // test knows plaintext
}

export async function fabricateServer(db, { owner, name }) {
  // server row + api_key_hash + ownership; mirrors cmd_pair's claim()
}

export async function fabricateMembership(db, { serverId, userId, role }) {
  // server_members row — what invite enrollment produces
}
```

Then the Playwright test signs in as that user via the real login form
(`/signin`, email + password) — **no session injection**. That keeps the
auth journey itself under test.

### Multi-user scenarios (the point)

| Scenario | Users | Asserts |
|---|---|---|
| A saves, B can't load | alice@test (owner), bob@test (invitee) | Bob sees Alice's game in the library and can play it; Bob's `list_saves` is empty; Alice's `list_saves` has her entry; Alice loads `0005` |
| Shared library | alice, bob | Bob (invitee) launches Alice's game — library visible to members |
| Play-time attribution | alice, bob | sessions recorded per user; per-user play time differs |
| Invite → membership | admin@test, invitee@test | invitee becomes member, gains server access (already covered by #599 tests at unit level; L2 proves it end-to-end) |
| Non-member blocked | stranger@test | stranger hits gateway server page → forbidden, no capability |

### Isolated fixture users

Every test run fabricates **fresh users** (uuid-suffixed emails) against the
disposable Postgres — no shared state, no cross-run contamination, no
deleting required. CI's Postgres container is throwaway per run.

## 5. Server-side changes (#745)

1. **LAN player page** (`player_server.rs`): the anonymous library/player
   page becomes an auth-gate. Two modes:
   - `standalone` (unpaired): still serves the library **if** a gateway URL
     is configured; otherwise shows "set up with a gateway" instructions.
     Direct hit without session → gate page → redirect to gateway signin.
   - paired: same gate; the gateway is the configured sc-web URL.
2. **DC auth message** gains the account id: server resolves the capability
   → account, stores it on the session; `auth_ok` includes it.
3. **Save stack keys** become `(account_id, rom_hash)`:
   `saves::{save_stack_push, save_stack_load, save_stack_list}` gain an
   account param. **No migration** — nobody has a working save yet, clean
   break (decision 2026-08-03). Old entries simply become unreachable.
4. **Play time**: session end records `(account_id, game_id, duration)`;
   gateway aggregates per user.

### Isolation model (decided 2026-08-03, refined)

**Shared: the library. Per-user: the artifacts.** A member can see and play
every game on a server they're invited to; their saves, save states, and
play time are strictly their own — even on someone else's server.

- **Library visibility**: membership-based. Invite → `server_members` row →
  the invitee sees the server's game list and can launch any game (this is
  the existing invite/member flow, #599/#610 — L2 proves it end-to-end).
- **Save stack** (`save_stack_*`): keyed `(account_id, rom_hash)`. Bob's
  `list_saves` on Alice's server returns only Bob's entries — Alice's saves
  are invisible to him and vice versa.
- **Play time**: per (account, game); per-user views only.
- **The auth gate** (below) is what stops *non-members* — anonymous or
  foreign users — from reaching the LAN page at all.

## 6. L2 harness surface (new `e2e/l2/`)

```
e2e/l2/
  run-l2.sh            — Postgres up → migrate → sc-web up → sc-server paired → Playwright
  lib/fabricate.ts     — user/server/membership fabrication (above)
  tests/auth-gate.spec.ts     — direct hit → gate → login → play  (the #745 journey)
  tests/multi-user.spec.ts    — A saves / B can't see / A reloads  (the point)
  tests/play-time.spec.ts     — per-user play time attribution
  playwright.config.ts — reuse l1 config (channel chrome, H.264)
```

CI: `e2e-l2` job — Postgres service container, sc-web build, sc-server
build, run-l2.sh. Slower than L1 (Next.js boot + full stack), so **manual /
`workflow_dispatch` for the full matrix, push-CI runs only the auth-gate
smoke** (same time-guard philosophy as L1/L2 split).

## 7. Sequencing (what I'll build next)

1. `#745` server-side: auth-gate page + DC account id + save-stack account
   keys (TDD: save-stack key tests RED→GREEN first — **no migration**)
2. `e2e/l2` machinery: fabricate.ts, run-l2.sh, Postgres wiring
3. `tests/auth-gate.spec.ts` — the #745 journey end-to-end (push-CI job)
4. `tests/multi-user.spec.ts` + `play-time.spec.ts` — different users,
   different artifacts (`workflow_dispatch` only)
5. CI `e2e-l2` job (auth-gate smoke on push) + docs

## 8. CI cost — the honest tradeoff (decision 2026-08-03)

Joel's question: *L2 is a full-stack job; is it worth the CI time?*

**The honest answer: a full L2 browser job on every push is NOT worth it.**
Here's why, and what I propose instead.

### Where the isolation logic actually lives

The strict-per-user isolation (save keys, list filtering, play-time
attribution) is **server-side Rust + gateway API logic** — testable at the
unit/integration level with fabricated users, *without a browser*. The
browser adds value for exactly two things:

1. The **auth-gate journey** (direct hit → gate → gateway signin → back →
   capability → play) — redirect/session behavior across two origins,
   genuinely browser-only.
2. One **multi-user browser sanity pass** (alice saves, bob sees nothing,
   alice reloads) — proving the API-level isolation holds through the real
   UI.

### Proposed split (mirrors the existing L1/soak time-guard)

| Layer | Where it runs | Cost |
|---|---|---|
| Save-stack account keys + isolation unit tests (Rust) | push CI (`rust` job) | ~free (already builds) |
| Gateway API tests w/ fabricated users (vitest) | push CI (`web` job) | ~free (already runs) |
| **L2 browser: auth-gate smoke** | push CI, ONE job | ~4-6 min (sc-server build dominates; reuses L1 pattern) |
| **L2 browser: multi-user + play-time** | `workflow_dispatch` only | 0 min on push; on demand |

That keeps push-CI bounded (~same as today + one L2 job) while the heavy
multi-user matrix stays on-demand — exactly the philosophy of
`e2e-soak.yml`.

If even the auth-gate smoke feels heavy, the fallback is: auth-gate becomes
on-demand too, and push-CI covers isolation purely at unit/API level. Your
call — but the split above is my recommendation.
