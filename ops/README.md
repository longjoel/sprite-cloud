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

Normal users should install a user service with [the sc-server installation guide](../docs/SC-SERVER-INSTALL.md). The units in `ops/` are operator/developer recovery templates for managed system services.

### Managed sc-server host

The managed unit runs as `sprite-cloud`, reads `/etc/sprite-cloud/config.toml`, and uses the data/core paths declared by the unit and environment file. Its ROM root must be readable by `sprite-cloud`.

```bash
# systemd unit
sudo cp ops/dev-host/sc-server.service /etc/systemd/system/
sudo systemctl daemon-reload

# environment (fill in real values from secrets)
sudo cp ops/dev-host/sprite-cloud.env.example /etc/sprite-cloud.env
sudo $EDITOR /etc/sprite-cloud.env

# create the service-owned config directory
sudo install -d -o sprite-cloud -g sprite-cloud -m 750 /etc/sprite-cloud

# pair through the same XDG path used by the system unit
sudo -u sprite-cloud env XDG_CONFIG_HOME=/etc \
  /usr/local/bin/sc-server pair <CODE> \
  --sc-web-url https://your-gateway.example
```

Do not manually paste API keys into the config or pair as the invoking login user.

### VPS
```bash
# compose
mkdir -p /docker/sc-web
cp ops/vps/docker-compose.yml /docker/sc-web/

# environment (fill in real values from secrets)
cp ops/vps/.env.example $VPS_ENV_FILE
$EDITOR $VPS_ENV_FILE

# build + deploy from dev machine
./scripts/deploy-sc-web.sh
```

## Cross-reference

- `docs/self-hosting-multiplayer.md` — operator-facing multiplayer mode guide (`lan-only`, `stun-capable`, `turn-capable`, `misconfigured`)
- `docs/DEPLOY.md` — full deployment guide
- `docs/RELEASE.md` — release system and CI gate policy
- `scripts/deploy-dev.sh` — dev/self-host deploy script
- `scripts/deploy-sc-web.sh` — VPS web deploy script
