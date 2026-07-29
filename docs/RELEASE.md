# Release System

Sprite Cloud release flow builds the host runtime (`sc-server` and its `sc-core`
child process) plus the `sc-web` production bundle/container.

## Artifacts

| Artifact | Purpose |
|---|---|
| `scripts/build-release.sh` | Builds `sc-server`, `sc-core`, and the `sc-web` production bundle |
| `scripts/deploy-dev.sh` | Installs both Rust binaries, writes release markers, restarts systemd |
| `scripts/deploy-sc-web.sh` | Deploys the built sc-web bundle into the running gateway container |
| `scripts/smoke-test.sh` | Checks local/remote release markers and health endpoints |
| `ops/` | Repo-tracked deployment templates |

The host runtime ships `sc-server` together with the `sc-core` child binary that
runs libretro cores in an isolated process.

## Required deploy environment

The deploy scripts do not hardcode a public domain. Set these explicitly:

```bash
export GV_VPS_HOST=your-gateway-host
export GV_WEB_URL=https://your-gateway.example
```

Optional overrides:

```bash
export GV_VPS_USER=root
export GV_PUBLIC_HEALTH_URL=https://your-gateway.example/api/health
export GV_WEB_HEALTH_URL=https://your-gateway.example/api/health
```

## Standard flow

```bash
# 1. Build
./scripts/build-release.sh

# 2. Deploy host
./scripts/deploy-dev.sh

# 3. Deploy gateway web
./scripts/deploy-sc-web.sh

# 4. Verify
./scripts/smoke-test.sh
```

## Release markers

| Location | Meaning |
|---|---|
| `/var/lib/sprite-cloud/RELEASE_COMMIT` | Host deployed SHA |
| `/var/lib/sprite-cloud/RELEASE_MANIFEST.json` | Host artifact manifest |
| `/docker/sc-web/RELEASE_COMMIT` | Gateway deployed SHA |
| `/docker/sc-web/RELEASE_MANIFEST.json` | Gateway release manifest |
| `.release/RELEASE_COMMIT` | Local build SHA |
| `.release/release-manifest.json` | Local build manifest |

## Migration workflow

Generate migrations during development. For a destructive migration, production
ordering is code first, health verification second, verified backup third, and
migration last. The migration helper enforces the backup step before applying SQL:

```bash
cd sc-web
npx drizzle-kit generate
cd ..
./scripts/deploy-sc-web.sh
./scripts/smoke-test.sh
./scripts/apply-sc-web-migration.sh sc-web/drizzle/<destructive-migration>.sql
```

Backward-compatible additive migrations may be applied before the matching code.

For a new self-hosted install, `GV_WEB_SCHEMA_PUSH_ON_START=1` may initialize an empty database. It refuses to run against a nonempty database; existing installations must apply reviewed migrations explicitly.

## CI gate

Before public release, CI should run:

```bash
cargo test --workspace
cd sc-web && pnpm run lint && pnpm test && pnpm build
```

Every commit on `main` should be deployable or immediately revertible.
