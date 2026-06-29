# Development Guide

## Repository structure

```text
sprite-cloud/
├── gv-web/             Next.js gateway app and browser player assets
│   ├── app/            App router pages and API routes
│   ├── lib/            Auth, DB, command/session helpers
│   ├── tests/          Vitest tests
│   └── public/player/  Browser WebRTC player client
├── gv-server/          Rust host runtime CLI/service
├── gv-core/            Shared game/core metadata helpers
├── libretro-runner/    Libretro execution support
├── docker/             Container entrypoints
├── ops/                Deployment templates
├── scripts/            Reusable install/build/deploy/dev scripts
└── docs/               Current public documentation
```

There is no separate production worker crate or binary. The emulator/runtime path is part of `gv-server`.

## Local development

Gateway:

```bash
cd gv-web
pnpm install
cp .env.example .env.local
pnpm exec drizzle-kit push
pnpm dev
```

Host runtime:

```bash
cargo run -p gv-server -- --help
cargo run -p gv-server -- start
```

Combined helper:

```bash
./scripts/dev-start.sh build
./scripts/dev-start.sh start
./scripts/dev-start.sh status
./scripts/dev-start.sh stop
```

## Code style

### Rust

- Rust edition 2024
- Use `cargo fmt`
- Use `tracing` for logging
- Keep runtime config in `gv-server/src/config.rs` or documented env/config files
- Avoid committing generated binaries, ROMs, downloaded cores, or build output

### TypeScript/Next.js

- API routes live under `gv-web/app/api/**/route.ts`
- Shared DB/auth/session helpers live under `gv-web/lib/`
- Database schema uses Drizzle
- Tests use Vitest
- Run `pnpm run lint`, `pnpm test`, and `pnpm build` before public-facing changes

### Browser player JavaScript

- Served directly from `gv-web/public/player/`
- Vanilla ES modules; no separate bundling step
- Keep protocol changes reflected in `docs/PROTOCOL.md` and `docs/datachannel-protocol.md`

## Adding a host command

1. Add/adjust the command payload shape in `gv-web` route/schema code.
2. Add or update the `gv-server` command handler.
3. Add tests on both sides when the behavior is externally visible.
4. Update `docs/PROTOCOL.md` if the component contract changed.
5. Update `docs/API.md` if an HTTP route or response changed.

## Adding an API route

1. Create `gv-web/app/api/<path>/route.ts`.
2. Add appropriate auth: browser session, host bearer token, setup code, or public-safe read-only access.
3. Validate input explicitly.
4. Add Vitest coverage.
5. Update `docs/API.md` and, if relevant, `docs/PROTOCOL.md`.

## Commit/release discipline

Before committing meaningful changes:

```bash
cargo test --workspace
cd gv-web && pnpm run lint && pnpm test && pnpm build
git diff --check
```

Release/build entrypoints are documented in `docs/RELEASE.md` and `scripts/README.md`.

## Public repo rules

- No secrets, setup codes, API keys, tokens, passwords, or private connection strings
- No ROMs, downloaded libretro cores, generated bundles, or large artifacts
- No hardcoded personal domains as defaults
- No historical scratchpad plans in public docs
- Keep docs focused on the architecture that exists now
