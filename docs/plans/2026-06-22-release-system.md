# Games Vault Release System Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Replace ad hoc deploy guessing with a single release path that stamps commits, deploys reproducibly, and verifies the live state on both the host and VPS.

**Architecture:** Keep this deliberately small. Use repo-tracked shell scripts plus repo-tracked ops templates as the source of truth. Build locally, deploy explicitly to each target, stamp `RELEASE_COMMIT` markers everywhere, and require smoke tests before promotion.

**Tech Stack:** bash, systemd, Docker Compose, GitHub Actions, gh CLI

---

## Current state captured

- Rust binaries are installed manually into `/usr/local/bin/`.
- gv-web is rebuilt and shipped to the VPS by hand.
- Live config exists partly outside the repo (`/etc/games-vault/config.toml`, systemd env, VPS compose/env).
- There was no deterministic answer to "what commit is running on VAULT vs VPS?"
- `main` was allowed to drift ahead of the last known-good deploy.

## Delivered in this slice

- `scripts/build-release.sh`
- `scripts/deploy-vault.sh`
- `scripts/deploy-vps-web.sh`
- `scripts/smoke-test.sh`
- `scripts/promote-main.sh`
- `scripts/release-common.sh`
- `ops/vault/*` templates
- `ops/vps/docker-compose.yml`
- `.github/workflows/ci.yml`
- `docs/RELEASE.md`

## Remaining follow-up work

### Issue A: Surface release metadata in live health responses

**Objective:** Expose deployed SHA/build metadata directly through runtime endpoints so Telegram debugging never requires shell access.

**Files:**
- Modify: `gv-web/app/api/health/route.ts`
- Modify: `gv-web/tests/api/routes.test.ts`
- Possibly modify: `gv-server/src/main.rs`

**Acceptance criteria:**
- `/api/health` includes release SHA/build metadata
- tests cover metadata-present and metadata-missing cases

### Issue B: Repo-tracked production env sync

**Objective:** Make repo templates the obvious source of truth for non-secret operational wiring.

**Files:**
- Modify: `ops/vault/games-vault.env.example`
- Modify: `ops/vps/docker-compose.yml`
- Add: `ops/vps/.env.example`
- Modify: `docs/DEPLOY.md`

**Acceptance criteria:**
- a new machine can be wired from repo-tracked templates without reading chat logs

### Issue C: Branch protection and release gate wiring

**Objective:** Prevent unstable code from landing on `main` without the new CI/build gate.

**Files:**
- Modify: GitHub repo settings
- Possibly add: `.github/PULL_REQUEST_TEMPLATE.md`
- Modify: `docs/RELEASE.md`

**Acceptance criteria:**
- branch protection requires CI before merge
- release flow documented in repo
