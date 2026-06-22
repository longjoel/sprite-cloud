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

1. `main` is stable-only. Every commit on `main` must pass CI. The CI workflow (`.github/workflows/ci.yml`) runs on every push and PR to `main`, building Rust release binaries + gv-web production bundle + running all tests. If CI is red, the commit does not go to production.

2. Branch protection: `main` requires CI to pass before merge. **Note:** GitHub branch protection rules require a public repo or GitHub Pro for private repos. If the repo is private and on the free plan, enforcement is manual — the release operator verifies CI green before deploying.

3. Every production deploy writes a `RELEASE_COMMIT` marker on both host and VPS so the live SHA is always answerable.

4. Never claim something is deployed until `smoke-test.sh` passes on both sides.

5. Any emergency rollback gets both a branch and a dated `known-good-*` tag for traceability.

6. Repo-tracked templates under `ops/` are the source of truth for service wiring — if a box diverges from `ops/`, the box is wrong.

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
