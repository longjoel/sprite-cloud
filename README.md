# Sprite Cloud

Self-hosted retro game library and browser streaming.

Sprite Cloud has three roles:

| Role | Runs where | What it does |
|---|---|---|
| `gv-web` | Gateway server | Web UI, email/password auth, setup wizard, library, pairing, command relay |
| `gv-server` | Host machine with ROMs | Polls the gateway, runs emulator cores in-process, streams video/audio over WebRTC |
| Browser player | Player device | Plays in the browser — no plugin or native app |

Architecture overview: **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)**
Protocol and wire formats: **[docs/PROTOCOL.md](docs/PROTOCOL.md)**

## Quick start

For the user-facing guide, see **[QUICKSTART.md](QUICKSTART.md)**.

### Run gv-web locally

```bash
cd gv-web
pnpm install
cp .env.example .env.local
# Edit .env.local — fill in DATABASE_URL and AUTH_SECRET at minimum.
pnpm exec drizzle-kit push
pnpm dev
```

Open `http://localhost:3000/setup`. On first run, the server prints a setup code to the console — use that code to create the first admin account.

### Pair and run a host

From the gateway dashboard, generate a pairing code. The UI shows the exact command, including the gateway URL:

```bash
gv-server pair ABCD-EFGH --gv-web-url https://your-gateway.example
```

Then point the host at your ROMs and start it:

```bash
export GV_ROM_ROOTS=/path/to/roms
cargo run -p gv-server -- start
```

## One-liner host install

```bash
curl -sSL https://raw.githubusercontent.com/longjoel/sprite-cloud/main/scripts/install.sh | sh -s -- --web-url https://your-gateway.example --rom-dir /path/to/roms
```

The installer detects Linux distro/arch, installs system dependencies, downloads `gv-server` from GitHub Releases, writes config, and installs a systemd service.

> Current state: release artifacts still need CI publishing before the one-liner is useful for public users. Until then, build from source as shown in [QUICKSTART.md](QUICKSTART.md).

## Docker host

Run a gv-server host in a container, auto-pairing on first start:

```bash
docker run -d \
  --name sprite-cloud-host \
  --network host \
  -v /path/to/roms:/roms:ro \
  -v sprite-cloud-saves:/saves \
  -e GV_PAIR_CODE=ABCD-EFGH \
  -e GV_WEB_URL=https://your-gateway.example \
  -e GV_ROM_ROOTS=/roms \
  ghcr.io/longjoel/sprite-cloud/gv-server:latest
```

The container pairs automatically on first run (reads `GV_PAIR_CODE` + `GV_WEB_URL`). On subsequent starts it reuses the saved credentials. Generate a pairing code from your gateway dashboard (Settings → Hosts).

> Note: Docker images are not yet published. Until CI is set up, use `docker compose` from the repo root (see `docker-compose.yml`).

## Manual host config

`gv-server pair` writes credentials to `~/.config/sprite-cloud/config.toml` or `/etc/sprite-cloud/config.toml` depending on install mode.

A minimal config looks like:

```toml
[gv_web]
url = "https://your-gateway.example"

[auth]
api_key = "gvsk_..."
server_id = "a0000000-..."

[rom]
roots = ["/path/to/roms"]
```

## Environment variables

See `.env.example` for the full list.

Important public deployment variables:

| Variable | Purpose |
|---|---|
| `AUTH_SECRET` | NextAuth secret |
| `AUTH_URL` | Public gateway origin |
| `DATABASE_URL` | Postgres connection string |
| `GV_WEB_SCHEMA_PUSH_ON_START=1` | Apply current schema at container startup |
| `GV_ICE_STUN_URLS` | Comma-separated STUN URLs |
| `GV_ICE_TURN_URLS` | Comma-separated TURN URLs |
| `GV_ICE_TURN_USERNAME` | TURN username |
| `GV_ICE_TURN_CREDENTIAL` | TURN credential |

Auth is DB-backed email/password. The first admin account is created through the setup wizard.

## License

Sprite Cloud is licensed under the **GNU Affero General Public License v3.0 or later**. See [LICENSE](LICENSE).

That means you may self-host, study, modify, and redistribute Sprite Cloud, but if you run a modified version as a network service, you must offer the corresponding source code to users of that service.

Commercial licensing is available separately for organizations that need terms outside the AGPL. Contributions require agreement to the [Contributor License Agreement](CLA.md) so the project can maintain a dual-license model.

See [NOTICE](NOTICE) for third-party notices, including GStreamer LGPL information.

## Status

Early development. The current architecture supports DB-backed auth, gateway pairing, ROM scanning, in-process libretro runtime, and browser WebRTC play. Public release still needs release CI and broader install-script verification.
