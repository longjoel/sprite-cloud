# ops/ — Production templates

Repo-tracked templates for deploying Games Vault. The files here are the **source of truth** for service wiring — if a box's config diverges from what's here, the box is wrong.

## What lives here

```
ops/
├── dev-host/                   dev/self-host gv-server host
│   ├── gv-server.service       systemd unit
│   └── games-vault.env.example environment template
├── vps/                        Gateway Docker host
│   ├── docker-compose.yml      gv-web compose file
│   └── .env.example            environment template
└── README.md                   this file
```

## What does NOT live here

- **Secrets** (`AUTH_SECRET`, `DATABASE_URL`, `GV_ICE_TURN_CREDENTIAL`, `GV_API_KEY`) — these stay on the box or in a secrets manager
- **Rust source code** — that's under `gv-server/`, `gv-core/`, and `libretro-runner/`
- **gv-web source** — under `gv-web/`
- **Deployment scripts** — under `scripts/`

## Recovery from templates

To reconstitute a fresh host from these templates:

### Dev/self-host gv-server host
```bash
# systemd unit
sudo cp ops/dev-host/gv-server.service /etc/systemd/system/
sudo systemctl daemon-reload

# environment (fill in real values from secrets)
sudo cp ops/dev-host/games-vault.env.example /etc/games-vault.env
sudo $EDITOR /etc/games-vault.env

# config
sudo mkdir -p /etc/games-vault
# write /etc/games-vault/config.toml with web URL, auth, ROM roots
```

### VPS
```bash
# compose
mkdir -p /docker/gv-web
cp ops/vps/docker-compose.yml /docker/gv-web/

# environment (fill in real values from secrets)
cp ops/vps/.env.example /docker/gv-web/.env
$EDITOR /docker/gv-web/.env

# deploy the web bundle (from dev machine)
./scripts/deploy-gv-web.sh
```

## Cross-reference

- `docs/DEPLOY.md` — full deployment guide
- `docs/RELEASE.md` — release system and CI gate policy
- `scripts/deploy-dev.sh` — dev/self-host deploy script
- `scripts/deploy-gv-web.sh` — VPS web deploy script
