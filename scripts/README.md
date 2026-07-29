# Sprite Cloud scripts

Keep this directory boring. Scripts here should be reusable release/dev entrypoints, not one-off experiments.

## Current scripts

| Script | Keep because |
|---|---|
| `install.sh` | Public/self-host host installer entrypoint |
| `dev-start.sh` | Local dev stack helper |
| `build-release.sh` | Builds `sc-server`, `sc-core`, and `sc-web` release artifacts |
| `deploy-dev.sh` | Deploys the dev/self-host `sc-server` and `sc-core` binaries |
| `deploy-sc-web.sh` | Rebuilds the sc-web Docker image on the VPS and restarts the host-network runtime safely |
| `apply-sc-web-migration.sh` | Applies an explicit Drizzle SQL migration |
| `smoke-test.sh` | Checks release markers and health endpoints |
| `release-common.sh` | Shared helpers for the release scripts above |

## Public install

```bash
curl -fsSL https://sprite-cloud.com/install.sh | bash
sc-server setup
```

This is the recommended user-facing, binary-only installation and upgrade path. See **[docs/SC-SERVER-INSTALL.md](../docs/SC-SERVER-INSTALL.md)**.

For a managed installation that also installs dependencies and a systemd service:

```bash
sudo ./scripts/install.sh \
  --web-url https://your-gateway.example \
  --rom-dir /srv/storage/games/roms
```

Use `--rootless` for a user service. Reinstalls preserve an existing config and never delete ROMs.

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

For destructive migrations that remove tables or columns, deploy code that no
longer reads them first, verify health, then run the migration helper. The helper
creates and verifies a timestamped compressed database backup before applying SQL:

```bash
./scripts/deploy-sc-web.sh
./scripts/smoke-test.sh
./scripts/apply-sc-web-migration.sh sc-web/drizzle/<destructive-migration>.sql
```

Backward-compatible additive migrations may be applied before the matching code.

## Rule

Do not add one-off smoke tests or local experiments here. Put them in a test suite, a historical plan, or keep them untracked.
