# Games Vault — Project Instructions

ASP.NET Core 10 web app for retro game library management and browser-based streaming via
Nosebleed + WebRTC. Deployed on VAULT at `:8090` behind an Nginx LAN gateway at `vault.local`.

## Repo and Deploy

- **Canonical repo:** `/root/projects/games-vault` on VAULT
- **Remote:** `https://github.com/longjoel/games-vault` (branch `main`)
- `/root/gv` is a mirror checkout — always fast-forward it after pushes, never work there

### Build

```bash
dotnet test --configuration Release        # 271 tests, must pass
python3 scripts/audit-tracked-binaries.py  # blocks committed binaries
dotnet publish games-vault.csproj -c Release -r linux-x64 --self-contained true -o <dir>
```

### Deploy (DEV — runs on VAULT, Jenkins triggers it)

```bash
/usr/local/sbin/games-vault-ci-deploy-dev        # normal (no-ops if already at same commit)
/usr/local/sbin/games-vault-ci-deploy-dev --force # force redeploy
```

### Deploy (PROD — manual, requires deploy.env secrets)

```bash
DEPLOY_SECRETS_FILE=./deploy.env ./scripts/deploy-prod-from-main.sh
```

### Post-deploy verify

```bash
systemctl is-active games-vault
cat /opt/games-vault/RELEASE_COMMIT
curl -fsS http://127.0.0.1:8090/
curl -fsS http://127.0.0.1:8090/Games
curl -fsS http://127.0.0.1:8090/Arcade
```

## Hard Rules

### Do NOT commit binaries
- `nosebleed-release` was a 14.5MB ELF that was tracked — removed. Never commit it again.
- `scripts/audit-tracked-binaries.py` runs in CI/deploy and blocks bin/obj/publish and any
  `*.exe`, `*.dll`, `*.so`, `*.dylib`, `*.pdb` under any directory depth.
- `.gitignore` and `.dockerignore` both cover these. Don't weaken them.

### Deploy must validate
The live deploy scripts (`/usr/local/sbin/games-vault-ci-deploy-*`) and
`scripts/deploy-prod-from-main.sh` all:
1. Require clean worktree
2. Require HEAD == origin/main (no local-ahead commits)
3. Run binary audit
4. Run `dotnet test`
5. Check JS syntax
6. Publish to a `mktemp -d /var/tmp/...` dir (NOT `/tmp`)
7. rsync with `--exclude App_Data/`, `--exclude wwwroot/art/`, `--exclude wwwroot/webplayer/`

### `/tmp` is disposable
Never use `/tmp` as a workspace directory. CI publish dirs use `/var/tmp/...` with `mktemp` and
a `trap cleanup EXIT`. The old practice of publishing to `/tmp/games-vault-dev-publish` is dead.

### CSP — no CDNs
Content-Security-Policy is strict. No external CDN scripts, styles, or fonts. Everything served
from `wwwroot/`. If you need a JS library, add it to `wwwroot/lib/` and reference locally.

### UI copy is terse
- Labels are single nouns, not action phrases
- No marketing prose ("you can", "use this to", "one place for", "behind the curtain")
- Empty states are one line
- When in doubt: cut words

## Architecture

### Stack
- .NET 10, ASP.NET Core MVC
- EF Core 10 with PostgreSQL (Npgsql)
- SixLabors.ImageSharp for art processing
- Serilog structured logging
- FIDO2/WebAuthn passkeys
- Nosebleed subprocess management for game streaming (via `NosebleedSessionManager`)

### Key subsystems
| Area | Path | Purpose |
|------|------|---------|
| Auth/Profiles | `Profiles/`, `Controllers/PasskeysController.cs` | Profile-local auth, WebAuthn |
| Game streaming | `Nosebleed/`, `Controllers/ArcadeController.cs`, `Controllers/RoomController.cs` | Launch Nosebleed, WebRTC relay |
| Game library | `Libretro/Import/`, `Controllers/GamesController.cs`, `Controllers/ImportController.cs` | Scan, upload, match, import |
| Background jobs | `BackgroundJobs/` | Art backfill, preview generation via internal job queue |
| Network shares | `NetworkShares/` | SMB library scanning |
| EverDrive | `EverDrive/` | GB/GBA firmware service |
| Admin | `Controllers/AdminController.cs` | Dashboard with system health |
| DB | `Data/`, `Migrations/` | EF Core with PostgreSQL |

### Database
- PostgreSQL on port 5433
- Connection string in `/etc/systemd/system/games-vault.service.d/database.conf`
- Migrations: `Migrations/` (recent ones for BackgroundJob tables, GameArt metadata, Preview images)
- **Never** commit `appsettings.*.json` with real secrets — only `appsettings.json` with defaults

### Nosebleed integration
- Binary: `/opt/nosebleed/nosebleed` (configured in `NosebleedOptions.BinaryPath`)
- Cores: `/srv/storage/games-vault/nosebleed/cores/`
- Sessions: `/srv/storage/games-vault/nosebleed/sessions/`
- Auth secret: `/var/lib/games-vault/nosebleed-auth-secret` (auto-generated if missing)
- Stream settings: `/var/lib/games-vault/nosebleed-stream-settings.json`
- Docker builds Nosebleed from GitHub release (`NosebleedVersion` env var)
- VAULT host gets Nosebleed via `nosebleed-release` in `/opt/nosebleed/`

### Systemd
- Service: `games-vault.service`
- Override dirs: `/etc/systemd/system/games-vault.service.d/`
  - `database.conf` — connection string
  - `nosebleed.conf` — Nosebleed env vars
  - `art.conf` — `ReadWritePaths=/opt/games-vault/wwwroot/art`
- `wwwroot/art/` must exist or systemd namespace mount kills the process

### Jenkins
- Jenkins is active on port 8080
- `games-vault-dev` job: timer every 5 min, calls `/usr/local/sbin/games-vault-ci-deploy-dev`
- `games-vault-prod` job: manual, gated by `CONFIRM_PROD`, calls `/usr/local/sbin/games-vault-ci-deploy-prod`
- Jobs are inline Jenkins XML, NOT repo Jenkinsfiles
- Do NOT break these jobs

## Common Pitfalls

### ImageSharp vulnerability
`SixLabors.ImageSharp 3.1.7` has a known moderate advisory (GHSA-rxmq-m78w-7wmc).
Don't upgrade blindly — it may break the image pipeline. This is tracked.

### wwwroot/art must survive deploys
`rsync --delete` will remove `wwwroot/art/` if the publish output doesn't include it
(it's a runtime-only mount). The deploy scripts now exclude `wwwroot/art/` from rsync
and explicitly `mkdir -p` it after sync. Do not remove those guards.

### Deploy requires origin/main match
Deploy scripts refuse if `HEAD != origin/main`. Push first, then deploy.

### Concurrent deploys
Both dev and prod scripts use `flock /run/lock/games-vault-ci-deploy-*.lock`.
They will not overlap.

### Docker Compose
`docker-compose.yml` in the repo is the development compose. Production VPS deploys
via the shell scripts, not Compose.

### Migrations
After adding a migration, update `AppDbContextModelSnapshot.cs` and include the
Designer file. Run `dotnet ef database update` manually on VAULT after deploy
if the migration isn't applied automatically.

## Test Coverage
- 271 tests, all passing
- Test project: `tests/games-vault.Tests/`
- Includes: markup tests, controller tests, service tests, integration tests
- JS tests: `tests/js/nosebleed-preview.test.js`, `tests/js/server-player-helpers.test.js`
