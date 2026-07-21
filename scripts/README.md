# Sprite Cloud scripts

Keep this directory boring. Scripts here should be reusable release/dev entrypoints, not one-off experiments.

## Current scripts

| Script | Keep because |
|---|---|
| `install.sh` | Public/self-host host installer entrypoint |
| `dev-start.sh` | Local dev stack helper |
| `build-release.sh` | Builds `sc-server` and `sc-web` release artifacts |
| `deploy-dev.sh` | Deploys the dev/self-host `sc-server` binary |
| `deploy-sc-web.sh` | Rebuilds the sc-web Docker image on the VPS and restarts the host-network runtime safely |
| `apply-sc-web-migration.sh` | Applies an explicit Drizzle SQL migration |
| `smoke-test.sh` | Checks release markers and health endpoints |
| `release-common.sh` | Shared helpers for the release scripts above |

## Public install

```bash
curl -sSL https://raw.githubusercontent.com/longjoel/sprite-cloud/main/scripts/install.sh \
  | sh -s -- --web-url https://your-gateway.example --rom-dir /path/to/roms
```

## Local dev

```bash
./scripts/dev-start.sh build
./scripts/dev-start.sh start
./scripts/dev-start.sh status
./scripts/dev-start.sh stop
```

## Release flow

```bash
./scripts/build-release.sh
./scripts/deploy-dev.sh
./scripts/deploy-sc-web.sh
./scripts/smoke-test.sh
```

If schema changes exist:

```bash
./scripts/apply-sc-web-migration.sh sc-web/drizzle/<migration>.sql
./scripts/deploy-sc-web.sh
```

## Rule

Do not add one-off smoke tests or local experiments here. Put them in a test suite, a historical plan, or keep them untracked.
