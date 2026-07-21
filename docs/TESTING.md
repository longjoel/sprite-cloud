# Testing Guide

Run tests from the repository root unless a command says otherwise.

## Standard gate

```bash
cargo test --workspace
cd sc-web && pnpm run lint && pnpm test && pnpm build
bash -n scripts/*.sh tests/*.sh docker/sc-web/entrypoint.prod.sh docker/sc-server/entrypoint.sh
git diff --check
```

## Rust workspace

The Cargo workspace contains:

- `sc-server` — host runtime CLI and WebRTC/session orchestration
- `sc-core` — shared game/core metadata logic
- `libretro-runner` — libretro execution support

Run all Rust tests:

```bash
cargo test --workspace
```

Run one package:

```bash
cargo test -p sc-server
cargo test -p sc-core
cargo test -p libretro-runner
```

## sc-web

`sc-web` uses Next.js, TypeScript, Drizzle, and Vitest.

```bash
cd sc-web
pnpm install
pnpm run lint
pnpm test
pnpm build
```

The integration tests start/use disposable Postgres state where needed. They should not depend on a developer's production database.

## Browser/player checks

The browser player is served from `sc-web/public/player`. It has no separate build step. Current automated coverage lives in the `sc-web` Vitest suite and the lightweight gateway smoke script.

## Smoke check

For a configured gateway:

```bash
GV_WEB_URL=https://your-gateway.example ./tests/e2e-pipeline.sh
```

That script verifies gateway health and ICE config. A full browser/WebRTC/known-ROM e2e test is not currently checked in.

## Release script syntax

After editing shell scripts or container entrypoints:

```bash
bash -n scripts/*.sh tests/*.sh docker/sc-web/entrypoint.prod.sh docker/sc-server/entrypoint.sh
```

## What should not be in tests

- Hardcoded personal domains or hostnames
- Real session cookies, setup codes, API keys, TURN credentials, or passwords
- Assumptions that a separate worker process exists
- Tests that require private ROMs or local-only paths unless clearly marked as manual
