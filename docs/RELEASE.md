# Release System

Games Vault now has a single release path. No more mystery deploys.

## Artifacts

- `scripts/build-release.sh` — builds Rust release binaries and gv-web production bundle
- `scripts/deploy-vault.sh` — installs `gv-server` + `gv-worker`, writes release markers, restarts systemd, runs worker smoke test
- `scripts/deploy-vps-web.sh` — builds `gv-web-prod`, ships it to the VPS, writes release markers, restarts the service, verifies public health
- `scripts/smoke-test.sh` — checks local and remote release markers plus health endpoints
- `scripts/promote-main.sh` — optional stable-branch promotion after deploy + smoke
- `ops/vault/*` — repo-tracked host config templates
- `ops/vps/docker-compose.yml` — repo-tracked VPS compose template
- `.github/workflows/ci.yml` — compile/build gate on PRs and pushes

## Release markers

Every release now writes the commit SHA into deterministic places:

- local host: `/var/lib/games-vault/RELEASE_COMMIT`
- local host: `/var/lib/games-vault/RELEASE_MANIFEST.json`
- VPS web: `/docker/gv-web/RELEASE_COMMIT`
- VPS web: `/docker/gv-web/RELEASE_MANIFEST.json`
- local build output: `.release/RELEASE_COMMIT`
- local build output: `.release/release-manifest.json`

That means the first debugging question is answerable immediately:

```bash
cat /var/lib/games-vault/RELEASE_COMMIT
ssh root@lngnckr.tech 'cat /docker/gv-web/RELEASE_COMMIT'
```

## Standard flow

### 1. Build

```bash
./scripts/build-release.sh
```

### 2. Deploy the host binaries

```bash
./scripts/deploy-vault.sh
```

### 3. Deploy the VPS web app

```bash
./scripts/deploy-vps-web.sh
```

### 4. Verify both sides

```bash
./scripts/smoke-test.sh
```

### 5. Promote `main` only after success

```bash
./scripts/promote-main.sh --deploy-first
```

## Rules

1. `main` is stable-only.
2. Every production deploy writes a `RELEASE_COMMIT` marker.
3. Never claim something is deployed until `smoke-test.sh` passes.
4. Any emergency rollback gets both a branch and a dated `known-good-*` tag.
5. Repo-tracked templates under `ops/` are the source of truth for service wiring.
