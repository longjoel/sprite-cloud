# Development Conventions

How we work on the Games Vault v2 monorepo.

---

## Repository structure

```
games-vault/
├── gv-web/            Next.js 15 web app (TypeScript)
│   ├── app/           App router pages + API routes
│   ├── lib/           Shared logic (auth, db, commands, notify)
│   ├── __tests__/     vitest test suite
│   └── public/player/ Browser WebRTC client (vanilla JS)
├── gv-server/         Rust CLI (polls gv-web, manages workers)
├── gv-worker/         Rust per-game WebRTC peer
├── gv-player/         (legacy — empty, player lives in gv-web/public/player/)
├── docs/              Protocol, API reference, ADRs, guides
└── .hermes/           Agent plans and skill references (gitignored)
```

**Workspace setup:**
- pnpm workspace: `pnpm-workspace.yaml` (gv-web)
- Cargo workspace: root `Cargo.toml` (gv-server, gv-worker)
- No shared Rust library crate — each binary is self-contained
- gv-worker binary is consumed by gv-server via `spawn_worker()`, not Cargo dep

---

## Branch strategy

Single active branch: `main`. All development happens on `main`.

- Feature branches: `feat/<name>` — merge directly to `main`
- Fix branches: `fix/<name>` — merge directly to `main`
- No release branches, no develop branch
- gv-test VPS deploys from `main` tip (Docker Compose)
- Vault deploys from `main` tip (systemd)

Before committing, verify:
```bash
git branch --show-current  # Must show "main"
```

---

## Commit conventions

[Conventional Commits](https://www.conventionalcommits.org/):

```
feat(scope): description
fix(scope): description
docs(scope): description
chore(scope): description
refactor(scope): description
test(scope): description
```

**Scopes:** `worker`, `player`, `server`, `web`, `docs`, `ci`, `deps`

**Examples:**
```
fix(worker): browser creates DataChannel as offerer
feat(player): debug HUD with stats panels and pipeline indicators
docs: gv-worker HTTP endpoint reference
```

Reference issue numbers in the commit body (not the summary line):
```
fix(worker): handle mutex poison gracefully instead of panicking

Closes #42
```

---

## Code style

### Rust

- Edition 2024
- `cargo fmt` (standard Rust style)
- `cargo clippy` — no warnings allowed
- `#![deny(unsafe_code)]` unless explicitly needed (libvpx FFI)
- `tracing` for all logging — no `println!`/`eprintln!`
- JSON log output to stdout via `tracing-subscriber`
- All tunable values go in `config.rs` as `pub const` or `LazyLock`
- Retry logic centralized in `gv-server/src/retry.rs` — `with_retry()`

### TypeScript / Next.js

- Prettier for formatting
- ESLint for linting
- Path aliases via `tsconfig.json`
- Server actions and API routes in `app/api/`
- Database queries via Drizzle ORM
- Auth via NextAuth.js v5

### JavaScript (gv-player)

- Vanilla JS, no build step
- ES modules (`import`/`export`)
- JSDoc type annotations on all public methods
- No framework dependencies
- `"use strict"` implied by module mode

### Pre-commit hook

Stored in `.git/hooks/pre-commit`:
```bash
# JS syntax check on staged files
for f in $(git diff --cached --name-only --diff-filter=ACM | grep '\.js$'); do
  node -c "$f" || exit 1
done
```

---

## Adding a new command type

Commands flow: Browser → gv-web → gv-server → gv-worker.

1. **Add type to gv-web schema** — `lib/db/schema.ts` — add new variant to the command type union
2. **Create command route** (if needed) — `app/api/server/command/route.ts` — already generic, accepts any `type` string
3. **Add server handler** — `gv-server/src/commands.rs` — match on `cmd_type`, implement handler
4. **Update protocol doc** — `docs/PROTOCOL.md` — add sequence diagram, payload shape, error handling
5. **Add test** — gv-web: API route test; gv-server: unit test for poll response parsing
6. **Update API doc** — `docs/API.md` — if a new endpoint is added

No server restart required — gv-server polls for commands and picks up new types on next deploy.

---

## Adding a new API route (gv-web)

1. Create the route file in `app/api/<path>/route.ts`
2. Export handler functions: `GET`, `POST`, etc.
3. Add auth middleware — `auth()` for session, `validateServerAuth()` for API key
4. Add request validation (Zod schema or inline checks)
5. Add test in `__tests__/` — use vitest with `testClient` helper
6. Update `docs/API.md`
7. Update `docs/PROTOCOL.md` if it changes a contract between components

---

## Release process

1. All tests pass: `cargo test --workspace && cd gv-web && pnpm test`
2. Verify on gv-test VPS: deploy to Docker Compose, smoke test
3. Deploy to Vault: systemd restart
4. Tag if needed: `git tag v0.2.0 && git push --tags`

No version bumps in `package.json` or `Cargo.toml` — tags are the version
source of truth for now.
