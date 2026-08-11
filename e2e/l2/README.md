# L2 gateway-journey E2E (#662 slice 3 + #745)

Drives the **full production topology**: browser → sc-web gateway (auth) →
paired sc-server → nestopia. This is the slice that proves accounts work
end-to-end — the auth gate on direct hits, membership-based library
visibility, and (later) per-user artifact isolation.

## Topology

```
Playwright/Chrome ──► sc-web (Next.js :3000, disposable Postgres)
                        │  login (real NextAuth form) → library (/api/games)
                        ▼
                   sc-server (standalone + GV_GATEWAY_URL, :8787)
                        │  gate page on direct hit → gateway signin
                        ▼
                     nestopia + counter.nes (fixture from e2e/fixture)
```

`run-l2.sh` brings the whole stack up: Docker Postgres → `drizzle-kit push`
→ `next build` → sc-web → sc-server (standalone with `GV_GATEWAY_URL`, the
#745 flow) → Playwright → teardown. Artifacts (server logs, traces) land in
`$WORK/artifacts` and are kept when `KEEP_SERVER=1`.

## User fabrication (the heart of it)

`lib/fabricate.ts` inserts known users with bcrypt password hashes (same
cost as prod) into the test DB, then tests sign in through the **real**
NextAuth credentials form. Fresh uuid-suffixed identities per run against
throwaway Postgres = zero cross-run contamination.

The whole point of accounts (#745) is **different users against each
other** — fabricateUser/fabricateServer/fabricateMembership/fabricateGame
let any spec stand up alice + bob + stranger with any membership graph.

## Specs

| File | Scope | CI |
|---|---|---|
| `auth-gate.spec.ts` | direct hit → gate → gateway login → shared library; non-member blocked | push-CI smoke |
| `multi-user.spec.ts` | alice saves → bob can't load (artifact isolation) | on-demand (needs peer_tokens.user_id) |
| `play-time.spec.ts` | per-user play-time attribution | on-demand (needs peer_tokens.user_id) |

## Run locally

```bash
# one-time
cd e2e/l2 && npm install

# full run (needs: docker, cc65, release sc-server/sc-core, Chrome)
L2_CHROME_BIN=/snap/bin/chromium \
SC_SERVER_DIR=/root/projects/sprite-cloud/target/release \
./run-l2.sh
```

## CI

`e2e-l2` job in `.github/workflows/ci.yml`: builds sc-server, starts
Postgres + sc-web, runs `run-l2.sh`. Kept to the auth-gate smoke on push
per the CI-cost decision; the multi-user/play-time matrix is
`workflow_dispatch`-only.

## Known gaps (tracked)

- `peer_tokens` has no `user_id` — the server can't resolve a playing
  session to an account yet. Blocks multi-user/play-time specs through the
  real play path. Follow-up slice (see #745).
