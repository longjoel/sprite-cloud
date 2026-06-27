# Games Vault scripts

Keep this directory boring. Scripts here should be reusable release/dev entrypoints, not one-off experiments.

## Current scripts

| Script | Keep because |
|---|---|
| `install.sh` | Public/self-host host installer entrypoint |
| `dev-start.sh` | Local dev stack helper |
| `build-release.sh` | Builds `gv-server` and `gv-web` release artifacts |
| `deploy-dev.sh` | Deploys the dev/self-host `gv-server` binary |
| `deploy-gv-web.sh` | Deploys the gateway web bundle to the running container |
| `apply-gv-web-migration.sh` | Applies an explicit Drizzle SQL migration |
| `smoke-test.sh` | Checks release markers and health endpoints |
| `release-common.sh` | Shared helpers for the release scripts above |

## Public install

```bash
curl -sSL https://raw.githubusercontent.com/longjoel/games-vault/main/scripts/install.sh \
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
./scripts/deploy-gv-web.sh
./scripts/smoke-test.sh
```

If schema changes exist:

```bash
./scripts/apply-gv-web-migration.sh gv-web/drizzle/<migration>.sql
./scripts/deploy-gv-web.sh
```

## Rule

Do not add one-off smoke tests or local experiments here. Put them in a test suite, a historical plan, or keep them untracked.
