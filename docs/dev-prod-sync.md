# Dev/Prod Sync Rules (VAULT -> VPS)

## Source of truth
- `origin/main` is the only deploy source for prod.
- Never deploy from a dirty working tree.
- Every prod deploy writes `/opt/games-vault/RELEASE_COMMIT`.

## One-command flow
From repo root on VAULT:

```bash
./scripts/deploy-prod-from-main.sh
```

This script does:
1. Verify branch is `main` and repo is clean.
2. Fast-forward from `origin/main`.
3. Build/publish release artifact.
4. Backup prod DB.
5. Rsync artifact to VPS.
6. Ensure runtime dirs (including `App_Data`) + correct ownership.
7. Restart service.
8. Verify `/` and `/Arcade` on prod path-base URL.

## Drift check
Run anytime:

```bash
./scripts/check-dev-prod-sync.sh
```

Exit codes:
- `0`: in sync (`prod == origin/main`)
- `1`: drift detected
- `2`: prod release marker missing

## Team habit
- Merge PRs with squash into `main`.
- Deploy immediately after merge (or in a fixed release window), always with the script.
- If prod breaks, rollback by redeploying a known commit from `main` history.
