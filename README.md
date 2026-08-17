# Sprite Cloud

Self-hosted retro game library and browser streaming.

**[sprite-cloud.com](https://sprite-cloud.com)** — sign in, pair a server, and stream your library.

Sprite Cloud has three roles:

| Role | Runs where | What it does |
|---|---|---|
| `sc-web` | Optional gateway server | Hosted web UI, accounts, pairing, and command/WebRTC signaling relay |
| `sc-server` | Host machine with ROMs | Scans and serves the local library, runs emulator cores, and streams video/audio over WebRTC; can run standalone |
| Browser player | Player device | Plays in the browser — no plugin or native app |

Architecture overview: **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)**
Protocol and wire formats: **[docs/PROTOCOL.md](docs/PROTOCOL.md)**
Host installation and operations: **[docs/SC-SERVER-INSTALL.md](docs/SC-SERVER-INSTALL.md)**
Canonical setup + connectivity journey (beta): **[docs/SELF-HOSTING.md](docs/SELF-HOSTING.md)**

## Quick start

For the user-facing guide, see **[QUICKSTART.md](QUICKSTART.md)**.

### Run sc-server standalone (no account or gateway)

```bash
export GV_ROM_ROOTS=/path/to/roms
cargo run -p sc-server -- start --standalone
```

Open `http://<host-lan-ip>:8787`. The local page lists the server-owned library and launches games directly over WebRTC. ROM names and filesystem paths remain on the host.

### Run sc-web locally

```bash
cd sc-web
pnpm install
cp .env.example .env.local
# Edit .env.local — fill in DATABASE_URL and AUTH_SECRET at minimum.
pnpm exec drizzle-kit push
pnpm dev
```

Open `http://localhost:3000/setup`. On an empty database, the protected
bootstrap-invitation URL is emitted to the server logs; open that invitation
to create the first admin account. Do not treat the bootstrap URL or its
claim value as public documentation or commit it to a shell history.

### Configure, pair, and run a host

Configure the ROM root and core directory first:

```bash
sc-server setup
```

Open the gateway dashboard and generate a pairing code. The UI shows the exact command, including the gateway URL:

```bash
sc-server pair ABCD-EFGH --sc-web-url https://your-gateway.example
```

Then start the host:

```bash
sc-server start
```

## One-liner host install

```bash
curl -fsSL https://sprite-cloud.com/install.sh | bash
sc-server setup
```

The public installer detects Linux architecture, downloads the latest checksummed `sc-server` release, verifies SHA-256, and atomically installs the binary. Follow **[the host installation guide](docs/SC-SERVER-INSTALL.md)** for the beta support matrix, pairing, user-systemd setup, upgrades, persistence, troubleshooting, and managed/system-wide installations.

## Docker host

Run a sc-server host in a container, auto-pairing on first start:

```bash
docker run -d \
  --name sprite-cloud-host \
  --network host \
  -v /path/to/roms:/roms:ro \
  -v sprite-cloud-config:/root/.config/sprite-cloud \
  -v sprite-cloud-data:/root/.local/share/sprite-cloud \
  -v sprite-cloud-cores:/cores \
  -v sprite-cloud-saves:/saves \
  -e GV_PAIR_CODE=ABCD-EFGH \
  -e GV_WEB_URL=https://your-gateway.example \
  -e GV_ROM_ROOTS=/roms \
  -e GV_CORES_DIR=/cores \
  -e GV_DATA_DIR=/root/.local/share/sprite-cloud \
  ghcr.io/longjoel/sprite-cloud/sc-server:latest
```

The container pairs only when persistent config is absent. The named config volume preserves credentials across container recreation; the data, core, and save volumes preserve mutable host state. Generate a pairing code from your gateway dashboard (Settings → Hosts). Remove `GV_PAIR_CODE` from long-lived Compose configuration after the first successful pairing.

## Manual host config

The CLI normally writes through XDG to `~/.config/sprite-cloud/config.toml`. A managed system service uses `/etc/sprite-cloud/config.toml` only because its unit explicitly sets `XDG_CONFIG_HOME=/etc`; pair that service as its `sprite-cloud` account.

A minimal config looks like:

```toml
[sc_web]
url = "https://your-gateway.example"

[auth]
api_key = "scsk_..."
server_id = "a0000000-..."

[rom]
roots = ["/path/to/roms"]

[cores]
dir = "/usr/lib/libretro"
```

## Environment variables

See `.env.example` for the full list.

Important public deployment variables:

| Variable | Purpose |
|---|---|
| `AUTH_SECRET` | NextAuth secret |
| `AUTH_URL` | Public gateway origin |
| `DATABASE_URL` | Postgres connection string |
| `GV_WEB_SCHEMA_PUSH_ON_START=1` | Initialize schema only when the database is empty; existing databases require explicit migrations |
| `GV_ICE_STUN_URLS` | Comma-separated STUN URLs |
| `GV_ICE_TURN_URLS` | Comma-separated TURN URLs |
| `GV_ICE_TURN_USERNAME` | TURN username |
| `GV_ICE_TURN_CREDENTIAL` | TURN credential |

Auth is DB-backed and enrollment is invite-only: the first admin account is
created through the setup wizard, and every further member joins through an
invitation from an existing admin (no public sign-up).

## Community

**[Join the Sprite Cloud Discord](https://discord.gg/zujXa48kyS)** — discussion, support, and development.

## License

Sprite Cloud is licensed under the **GNU Affero General Public License v3.0 or later**. See [LICENSE](LICENSE).

That means you may self-host, study, modify, and redistribute Sprite Cloud, but if you run a modified version as a network service, you must offer the corresponding source code to users of that service.

Commercial licensing is available separately for organizations that need terms outside the AGPL. Contributions require agreement to the [Contributor License Agreement](CLA.md) so the project can maintain a dual-license model.

See [NOTICE](NOTICE) for third-party notices, including GStreamer LGPL information.

## Status

Early development. The current architecture supports DB-backed auth, gateway pairing, server-owned ROM scanning and library preferences, checksummed Linux release installers, libretro runtime, and browser WebRTC play.
