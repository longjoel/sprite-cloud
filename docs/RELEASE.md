# Release System

Games Vault now has a single release path. No more mystery deploys.

## Artifacts

- `scripts/build-release.sh` — builds Rust release binaries and gv-web production bundle
- `scripts/deploy-vault.sh` — installs `gv-server` + `gv-worker`, writes release markers, restarts systemd, runs worker smoke test
- `scripts/apply-gv-web-migration.sh` — applies a single Drizzle SQL migration to production Postgres with `ON_ERROR_STOP=1`. Run before deploy when schema changes exist.
- `scripts/deploy-gv-web.sh` — **blessed gv-web deploy**. Builds gv-web, packs standalone+static+public into a tar, extracts into the running VPS container, stamps runtime version, restarts, and verifies the deployed SHA via `/api/health`. Prefer this over `deploy-vps-web.sh` for routine deploys — it avoids a full Docker image rebuild.
- `scripts/deploy-vps-web.sh` — (legacy) rebuilds the `gv-web-prod` Docker image and ships it to the VPS. Still useful for image-level changes (Dockerfile, entrypoint).
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
# Preferred (tar-based, no Docker image rebuild):
./scripts/deploy-gv-web.sh

# Legacy (full Docker image rebuild):
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

1. `main` is stable-only. Every commit on `main` must pass CI. The CI workflow (`.github/workflows/ci.yml`) runs on every push and PR to `main`, building Rust release binaries + gv-web production bundle + running all tests. If CI is red, the commit does not go to production.

2. Branch protection: `main` requires CI to pass before merge. **Note:** GitHub branch protection rules require a public repo or GitHub Pro for private repos. If the repo is private and on the free plan, enforcement is manual — the release operator verifies CI green before deploying.

3. Every production deploy writes a `RELEASE_COMMIT` marker on both host and VPS so the live SHA is always answerable.

4. Never claim something is deployed until `smoke-test.sh` passes on both sides.

5. Any emergency rollback gets both a branch and a dated `known-good-*` tag for traceability.

6. Repo-tracked templates under `ops/` are the source of truth for service wiring — if a box diverges from `ops/`, the box is wrong.

## Runtime version verification

The deploy script stamps `gv-web/.next/runtime-version.json` with the git SHA, branch, and build timestamp. The `/api/health` endpoint reads this file (preferring it over Docker env vars) and reports the live version:

```bash
# Check deployed SHA
curl -s https://lngnckr.tech/api/health | python3 -c "import json,sys; print(json.load(sys.stdin)['versions']['web']['git_sha'])"

# The deploy script also verifies this automatically after restart
```

This means the first debugging question is answerable in one command: "what code is actually running on the VPS?"

## Migration workflow

Schema changes must be applied explicitly before deploying new code. Production startup never runs interactive schema push (`GV_WEB_SCHEMA_PUSH_ON_START=0` in `entrypoint.prod.sh`).

### Generating a migration

```bash
cd gv-web
npx drizzle-kit generate
# → writes to gv-web/drizzle/0012_<name>.sql
```

### Applying a migration (before deploy)

```bash
# Review the generated SQL first
cat gv-web/drizzle/0012_<name>.sql

# Apply to production Postgres (fails on SQL error)
./scripts/apply-gv-web-migration.sh gv-web/drizzle/0012_<name>.sql

# Then deploy the new code
./scripts/deploy-gv-web.sh
```

### Order

1. Generate migration → `npx drizzle-kit generate`
2. Review the SQL → `cat gv-web/drizzle/0012_<name>.sql`
3. Apply to Postgres → `./scripts/apply-gv-web-migration.sh ...`
4. Deploy gv-web → `./scripts/deploy-gv-web.sh`
5. Verify → `curl -s https://lngnckr.tech/api/health`

## CI gate

The CI workflow (`.github/workflows/ci.yml`) is the release gate. It runs on:

- Every push to `main`
- Every pull request targeting `main`

Jobs:
1. **rust** — builds `gv-server` + `gv-worker` in release mode, runs unit tests, runs libretro-runner smoke tests
2. **web** — installs pnpm deps, builds gv-web production bundle

A separate deploy workflow (`.github/workflows/deploy.yml`) runs on push to `main` (gv-web/** paths only) and builds + ships the Docker image to the VPS, then health-checks it. It does NOT run on PRs — only on merge to `main`.

### Manual enforcement (private repo)

If the repo is private and GitHub branch protection is unavailable (free plan), the release operator enforces the gate manually:

```bash
# Before deploying, check CI status on the target commit
gh run list --branch main --workflow ci.yml --limit 1
# Must show ✓ (green)

# If red, do not deploy
```
