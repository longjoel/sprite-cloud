# Development Guide

## Repository structure

```text
sprite-cloud/
├── sc-web/             Next.js gateway app and browser player assets
│   ├── app/            App router pages and API routes
│   ├── lib/            Auth, DB, command/session helpers
│   ├── tests/          Vitest tests
│   └── public/player/  Browser WebRTC player client
├── sc-server/          Rust host runtime CLI/service
├── sc-core/            Shared game/core metadata helpers
├── libretro-runner/    Libretro execution support
├── docker/             Container entrypoints
├── ops/                Deployment templates
├── scripts/            Reusable install/build/deploy/dev scripts
└── docs/               Current public documentation
```

There is no separate production worker crate or binary. The emulator/runtime path is part of `sc-server`.

## Local development

Gateway:

```bash
cd sc-web
pnpm install
cp .env.example .env.local
pnpm exec drizzle-kit push
pnpm dev
```

Host runtime:

```bash
cargo run -p sc-server -- --help
cargo run -p sc-server -- start
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
- Keep runtime config in `sc-server/src/config.rs` or documented env/config files
- Avoid committing generated binaries, ROMs, downloaded cores, or build output

### TypeScript/Next.js

- API routes live under `sc-web/app/api/**/route.ts`
- Shared DB/auth/session helpers live under `sc-web/lib/`
- Database schema uses Drizzle
- Tests use Vitest
- Run `pnpm run lint`, `pnpm test`, and `pnpm build` before public-facing changes

### Browser player JavaScript

- Served directly from `sc-web/public/player/`
- Vanilla ES modules; no separate bundling step
- Keep protocol changes reflected in `docs/PROTOCOL.md` and `docs/datachannel-protocol.md`

## Adding a host command

1. Add/adjust the command payload shape in `sc-web` route/schema code.
2. Add or update the `sc-server` command handler.
3. Add tests on both sides when the behavior is externally visible.
4. Update `docs/PROTOCOL.md` if the component contract changed.
5. Update `docs/API.md` if an HTTP route or response changed.

## Adding an API route

1. Create `sc-web/app/api/<path>/route.ts`.
2. Add appropriate auth: browser session, host bearer token, setup code, or public-safe read-only access.
3. Validate input explicitly.
4. Add Vitest coverage.
5. Update `docs/API.md` and, if relevant, `docs/PROTOCOL.md`.

## Commit/release discipline

Before committing meaningful changes:

```bash
cargo test --workspace
cd sc-web && pnpm run lint && pnpm test && pnpm build
git diff --check
```

Release/build entrypoints are documented in `docs/RELEASE.md` and `scripts/README.md`.

## Public repo rules

- No secrets, setup codes, API keys, tokens, passwords, or private connection strings
- No ROMs, downloaded libretro cores, generated bundles, or large artifacts
- No hardcoded personal domains as defaults
- No historical scratchpad plans in public docs
- Keep docs focused on the architecture that exists now
