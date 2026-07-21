# ops/ — Production templates

Repo-tracked templates for deploying Sprite Cloud. The files here are the **source of truth** for service wiring — if a box's config diverges from what's here, the box is wrong.

## What lives here

```
ops/
├── dev-host/                   dev/self-host sc-server host
│   ├── sc-server.service       systemd unit
│   └── sprite-cloud.env.example environment template
├── vps/                        Gateway Docker host
│   ├── docker-compose.yml      sc-web compose file
│   └── .env.example            environment template
└── README.md                   this file
```

## What does NOT live here

- **Secrets** (`AUTH_SECRET`, `DATABASE_URL`, `GV_ICE_TURN_CREDENTIAL`, `GV_API_KEY`) — these stay on the box or in a secrets manager
- **Rust source code** — that's under `sc-server/`, `sc-core/`, and `libretro-runner/`
- **sc-web source** — under `sc-web/`
- **Deployment scripts** — under `scripts/`

## Recovery from templates

To reconstitute a fresh host from these templates:

### Dev/self-host sc-server host
```bash
# systemd unit
sudo cp ops/dev-host/sc-server.service /etc/systemd/system/
sudo systemctl daemon-reload

# environment (fill in real values from secrets)
sudo cp ops/dev-host/sprite-cloud.env.example /etc/sprite-cloud.env
sudo $EDITOR /etc/sprite-cloud.env

# config
sudo mkdir -p /etc/sprite-cloud
# write /etc/sprite-cloud/config.toml with web URL, auth, ROM roots
```

### VPS
```bash
# compose
mkdir -p /docker/sc-web
cp ops/vps/docker-compose.yml /docker/sc-web/

# environment (fill in real values from secrets)
cp ops/vps/.env.example /root/sprite-cloud/.env
$EDITOR /root/sprite-cloud/.env

# build + deploy from dev machine
./scripts/deploy-sc-web.sh
```

## Cross-reference

- `docs/self-hosting-multiplayer.md` — operator-facing multiplayer mode guide (`lan-only`, `stun-capable`, `turn-capable`, `misconfigured`)
- `docs/DEPLOY.md` — full deployment guide
- `docs/RELEASE.md` — release system and CI gate policy
- `scripts/deploy-dev.sh` — dev/self-host deploy script
- `scripts/deploy-sc-web.sh` — VPS web deploy script
