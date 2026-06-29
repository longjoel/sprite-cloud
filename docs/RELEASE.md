# Release System

Sprite Cloud release flow builds one host binary (`gv-server`) plus the `gv-web` production bundle/container.

## Artifacts

| Artifact | Purpose |
|---|---|
| `scripts/build-release.sh` | Builds `gv-server` and `gv-web` production bundle |
| `scripts/deploy-dev.sh` | Installs `gv-server`, writes release markers, restarts systemd |
| `scripts/deploy-gv-web.sh` | Deploys the built gv-web bundle into the running gateway container |
| `scripts/smoke-test.sh` | Checks local/remote release markers and health endpoints |
| `ops/` | Repo-tracked deployment templates |

The host runtime ships as the single `gv-server` binary.

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
./scripts/deploy-gv-web.sh

# 4. Verify
./scripts/smoke-test.sh
```

## Release markers

| Location | Meaning |
|---|---|
| `/var/lib/sprite-cloud/RELEASE_COMMIT` | Host deployed SHA |
| `/var/lib/sprite-cloud/RELEASE_MANIFEST.json` | Host artifact manifest |
| `/docker/gv-web/RELEASE_COMMIT` | Gateway deployed SHA |
| `/docker/gv-web/RELEASE_MANIFEST.json` | Gateway release manifest |
| `.release/RELEASE_COMMIT` | Local build SHA |
| `.release/release-manifest.json` | Local build manifest |

## Migration workflow

When schema changes exist:

```bash
cd gv-web
npx drizzle-kit generate
cd ..
./scripts/apply-gv-web-migration.sh gv-web/drizzle/<migration>.sql
./scripts/deploy-gv-web.sh
```

For simple self-hosted installs, `GV_WEB_SCHEMA_PUSH_ON_START=1` can apply the current schema at startup. For stricter production releases, keep it `0` and apply migrations explicitly.

## CI gate

Before public release, CI should run:

```bash
cargo test --workspace
cd gv-web && pnpm run lint && pnpm test && pnpm build
```

Every commit on `main` should be deployable or immediately revertible.
