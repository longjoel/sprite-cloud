# Sprite Cloud self-hosting and connectivity journey

**The one canonical path for a limited-beta operator.** This document is the
single starting point: it tells you which machine receives which component,
walks you through the whole journey (install → pair → verify → play → remote →
upgrade → recover), and explains connectivity in plain language before any
protocol detail. Deeper references are linked, not duplicated, so two canonical
paths cannot diverge.

Applies to the retained September limited-beta matrix. Rows not yet verified on
real hardware are marked **pending** and are **not advertised** as supported
until the evidence exists (see [Beta matrix](#beta-matrix)).

---

## 1. Which machine gets what

| Component | Machine | Purpose |
|---|---|---|
| **Gateway** (`sc-web` + Postgres + optional TURN) | A reachable server (VPS or a home box with a public IP) | Web UI, accounts, invite enrollment, pairing, signaling/command relay |
| **Game host** (`sc-server` + `sc-core`) | The Linux machine that owns the ROMs and cores | Scans the library, runs emulator cores, encodes and streams video/audio |
| **Browser player** | Any device with a modern browser | Plays in the browser — no install, no plugin |

**Rule of thumb:** install `sc-server` on the machine with the ROMs. Do not
install it on the gateway VPS unless that machine also intentionally hosts the
games.

Two supported topologies:

- **Hosted gateway** — you use the Sprite Cloud beta gateway
  (`https://sprite-cloud.com`). You only install the game host.
- **Self-hosted gateway** — you run the gateway yourself (production-equivalent
  topology, Docker Compose). You install the gateway *and* the game host.

Both topologies share the same host journey after the gateway URL is known.

---

## 2. The one obvious journey

### Step 0 — Have an invitation

The limited beta is **invite-only**. A new member gets access to the inviting
admin's gateway and library immediately — there is no public sign-up and no
self-service pairing. If you do not have an invite yet, start there.

### Step 1 — Install the game host (Linux, x86-64 or arm64)

Prerequisites: `curl`, `tar`, SHA-256 tooling, and GStreamer with the base,
good, bad, and ugly plugin sets:

```bash
# Debian/Ubuntu
sudo apt update
sudo apt install curl tar gstreamer1.0-plugins-base \
  gstreamer1.0-plugins-good gstreamer1.0-plugins-bad \
  gstreamer1.0-plugins-ugly gstreamer1.0-libav

# Fedora/Bazzite
sudo dnf install curl tar gstreamer1 gstreamer1-plugins-base \
  gstreamer1-plugins-good gstreamer1-plugins-bad-free \
  gstreamer1-plugins-ugly-free

# Arch
sudo pacman -S curl tar gstreamer gst-plugins-base gst-plugins-good \
  gst-plugins-bad gst-plugins-ugly
```

Install the binary (architecture is detected, release checksum is verified,
the executable is replaced atomically):

```bash
curl -fsSL https://sprite-cloud.com/install.sh | bash
```

A normal user installs to `~/.local/bin/sc-server`; root installs to
`/usr/local/bin/sc-server`; `SC_INSTALL_DIR=/custom/path` overrides. If
`~/.local/bin` is new, add it to `PATH`. Verify:

```bash
command -v sc-server
sc-server --version
```

The installer installs the binary only. It never touches configuration, ROMs,
saves, or an existing service.

### Step 2 — Configure the host

Run as the same login user that will run the service:

```bash
sc-server setup
```

The wizard asks for: **ROM directory → libretro cores directory → ICE transport
policy → STUN server**. It then prints the dashboard URL and scans the ROM root,
reporting how many games were recognized (a zero count usually means a wrong
path, unreadable files, or unsupported extensions).

Saved non-secret configuration lives in `~/.config/sprite-cloud/config.toml`;
mutable state lives in `~/.local/share/sprite-cloud/`. These survive pairing,
restarts, and upgrades. Inspect the non-secret parts with:

```bash
sed -n '/^\[rom\]/,/^\[/p; /^\[cores\]/,/^\[/p' ~/.config/sprite-cloud/config.toml
```

Do not publish the whole file: the `[auth]` section contains host credentials
after pairing. The optional `[dat]` section is documented in
[configuration.md](configuration.md).

### Step 3 — Pair with the gateway

1. Open the gateway dashboard.
2. Generate a pairing code (short-lived).
3. Run the displayed command on the game host:

```bash
sc-server pair <CODE> --sc-web-url https://your-gateway.example
```

Pairing writes the gateway URL and host credentials and preserves the ROM and
core settings from setup.

### Step 4 — Verify locally, then install the service

Run in the foreground first:

```bash
sc-server start
```

Confirm the server connects and the library appears in the gateway, then stop
with `Ctrl+C`. Do not leave a foreground server running when you start the
service — two processes with the same paired identity race for commands.

For LAN-only play without a gateway account (local library, direct WebRTC):

```bash
sc-server start --standalone
```

Then open `http://<host-lan-ip>:8787` in a browser on the same network.

Install the user service (never through `sudo`):

```bash
sc-server install
systemctl --user daemon-reload
systemctl --user enable --now sc-server
```

On headless hosts, enable lingering so the service starts without a login:

```bash
sudo loginctl enable-linger "$USER"
loginctl show-user "$USER" -p Linger   # expect Linger=yes
```

Check the service:

```bash
systemctl --user status sc-server
journalctl --user -u sc-server -n 100 --no-pager
```

### Step 5 — Play locally

Open the gateway in a browser and click a game. Expected behavior:

- The page connects over WebRTC (the browser may briefly show console noise
  about `screen.availWidth/Height` under Firefox Fingerprinting Protection —
  that is the browser, not Sprite Cloud).
- On the same LAN as the host, the connection takes the direct LAN path.

### Step 6 — Verify remote play: direct and relayed

Open the gateway health endpoint and read the `connectivity` block:

```text
https://your-gateway.example/api/health
```

| Mode | What it means | Good for |
|---|---|---|
| `lan-only` | No STUN/TURN configured | Same-machine/LAN play only |
| `stun-capable` | STUN configured, no TURN | Friendly home-network guests; hostile NAT/cellular may fail |
| `turn-capable` | STUN + usable TURN | **Recommended** for reliable remote guests |
| `misconfigured` | TURN looks configured but is unusable | Nothing — fix it first |

A remote guest on another network should connect through a relayed candidate
when the gateway is `turn-capable`. To prove the relay itself works, run the
TURN probe from anywhere:

```bash
node scripts/turn-probe.mjs turn:your-turn-host:3478 <username> <credential>
```

It reports one of: `unconfigured`, `reachable`, `credential-issued`,
`relayed` (allocation granted — the good outcome), or `failed`.

### Step 7 — Upgrade and recover

Upgrade the host binary and restart:

```bash
sc-server upgrade
systemctl --user restart sc-server
```

Installer fallback: rerun the installer, then restart. Upgrades preserve the
config, state, pairing, and ROMs. Rollback = install the previous release with
`SC_INSTALL_DIR`/installer and restart.

If the service stops responding: `systemctl --user status sc-server` and
`journalctl --user -u sc-server -n 200 --no-pager` first, then the connectivity
troubleshooting in the [decision tree](#4-symptom-first-decision-tree).

---

## 3. Plain-language connectivity: NAT, STUN, TURN, ICE

Two peers — the browser and the game host — must send video and input to each
other. Home and mobile networks do not give devices a public address: a **NAT**
rewrites private IPs to one public IP, and it generally blocks unsolicited
incoming connections. ICE is the strategy WebRTC uses to find a working path.

| Concept | What it is | In one sentence |
|---|---|---|
| **host candidate** | Your machine's own local IP | Works when both peers are on the same network |
| **STUN** | A public "what's my IP?" service | Tells a peer its public IP:port so the other side can reach it directly |
| **server-reflexive (srflx) candidate** | Your public IP:port as seen by STUN | Enables direct connections through friendly NATs |
| **TURN** | A public relay | When direct paths fail, BOTH peers' media goes through the TURN server |
| **relay candidate** | The TURN server's address | Guarantees a path through any NAT — at the cost of latency and relay bandwidth |
| **ICE** | The negotiation itself | Tries every candidate pair until one works; direct first, relay last |

**Direct (STUN) vs relayed (TURN).** Direct is lower latency and costs you
nothing but is impossible behind symmetric NAT/CGNAT. Relay works everywhere
but adds one network hop and consumes the relay's bandwidth. ICE prefers
direct and falls back to relay automatically — you do not choose per session,
you choose the *policy*:

| `GV_ICE_TRANSPORT_POLICY` | Candidates offered | Use when |
|---|---|---|
| `all` (default) | host + srflx + relay | Normal operation — maximum options |
| `relay` | relay only | You want all traffic through TURN (privacy/no IP disclosure) |

**Ports and cost.** STUN is UDP 3478 (or 19302 for Google's public servers).
TURN listens on UDP/TCP 3478 and allocates relay ports from a range
(49152–65535 in the examples). STUN is free and stateless. TURN relays actual
media, so it costs bandwidth — self-hosting it on a VPS is the standard
approach; the hosted beta gateway provides one for its operators.

**Docker networking.** When the gateway runs `sc-web` in a container next to
coturn on the same host, point `GV_ICE_TURN_URLS` at the Docker bridge gateway
(`turn:172.17.0.1:3478`) rather than the public hostname, or the container's
traffic hairpins out to the internet and back, which firewalls often drop.
With `network_mode: host`, `turn:127.0.0.1:3478` works instead.

**The LAN shortcut.** When the browser's IP matches a configured host LAN, the
gateway skips TURN for that session and ICE connects directly over the LAN —
the lowest-latency path, and how same-home play behaves:

```yaml
GV_SERVER_LAN_IPS: 192.168.1.100,10.0.0.5
```

---

## 4. Symptom-first decision tree

Start from what you observe, not folklore. Every branch names the evidence to
collect.

### A. The gateway health endpoint

Open `https://your-gateway.example/api/health`, read `connectivity`:

- `mode: "misconfigured"` → the relay is not usable. Check `turn_state` and
  `diagnostics`; fix `GV_ICE_TURN_USERNAME`/`GV_ICE_TURN_CREDENTIAL` to match
  coturn's `user=` line, restart `sc-web`, re-check health.
- `mode: "lan-only"` → no STUN/TURN configured. Add STUN (and TURN for remote
  guests) via the gateway environment, restart, re-check.
- `mode: "stun-capable"` → direct connections may work on friendly NATs. Add
  TURN for reliable remote guests.
- `mode: "turn-capable"` but guests still fail → go to B.

### B. Prove the relay independently

Run the probe from a machine that is *not* the gateway host:

```bash
node scripts/turn-probe.mjs turn:your-turn-host:3478 <username> <credential>
```

- `failed`/timeout → the TURN listener is not reachable on that path. Check the
  firewall (UDP 3478 + the relay range), coturn's `external-ip`, and that the
  hostname resolves to the public IP. Do not debug further in the browser.
- `credential-issued` but never `relayed` → the server challenges, but the
  allocation is refused: check the username/credential/realm against
  coturn's config and `turnserver.conf` log.
- `relayed` → the relay path works. The problem is elsewhere: go to C.

### C. Browser WebRTC internals

Open the player page, start a game, then:

- Firefox: `about:webrtc` → ICE connection log
- Chromium/Chrome: `chrome://webrtc-internals`

Look for the chosen candidate pair:

- `host`/`srflx` pair selected → direct path; latency is expected to be low.
- `relay` pair selected → relayed path; verify the relay hostname matches your
  TURN and that the connection `state` reached `connected`.
- No pair reaches `connected` → gather the logs in D with the failure's
  candidate names and timestamps.

### D. The three log sets

| Component | Where | What to look for |
|---|---|---|
| `sc-server` | `journalctl --user -u sc-server -n 200 --no-pager` | ICE candidate gathering, datachannel auth, `route: local LAN host` for LAN sessions |
| `sc-web` | `docker logs <sc-web-container>` (gateway) | `start_game`, ice-config, TURN config warnings |
| coturn | `journalctl -u coturn` (gateway host) | Allocation requests, `401` credential challenges, relay range exhaustion |

Attach the mode, `turn_state`, probe result, candidate pair, and log excerpts —
that combination uniquely identifies the failing layer.

---

## 5. Gateway deployment (self-hosted gateway)

Requirements: a server with Docker + Docker Compose, a public domain (or LAN),
and OpenSSL. Generate a protected `.env` before first start (the canonical
pattern from `QUICKSTART.md` — `POSTGRES_PASSWORD`, `AUTH_SECRET`, `AUTH_URL`),
then run the Compose stack (`postgres` + `sc-web`). On an empty database set
`GV_WEB_SCHEMA_PUSH_ON_START=1`; existing databases require the explicit
Drizzle migrations (see `docs/DEPLOY.md` and `scripts/apply-sc-web-migration.sh`).

First-run admin: `docker logs <sc-web-container>` shows the one-time setup
code; visit `/setup`, enter it, create the admin account. Enrollment from then
on is invite-only.

TURN on the gateway host (optional but recommended for remote guests):

```bash
sudo apt install coturn
```

`/etc/turnserver.conf` essentials: `listening-port=3478`, `external-ip=<public
IP>`, `min-port=49152`/`max-port=65535`, a long-term `user=` credential,
`fingerprint`, `no-loopback-peers`, `syslog`. Open UDP 3478 (and TCP for the
fallback) plus the relay range. Set `GV_ICE_TURN_URLS`,
`GV_ICE_TURN_USERNAME`, `GV_ICE_TURN_CREDENTIAL` on `sc-web` (using the Docker
bridge gateway address from inside the container — see the connectivity
section), and `GV_SERVER_LAN_IPS` for LAN-direct sessions.

Full operations detail: **[docs/DEPLOY.md](DEPLOY.md)**.

---

## 6. Beta matrix

Rows retained for the limited beta, with evidence status. Rows marked
**pending** are not advertised until verified on real hardware (#663).

| Platform | Architecture | Service mode | Status |
|---|---|---|---|
| Debian/Ubuntu | x86-64 | Rootless user service + managed system service | **Verified** (installer contract + ops tested) |
| Debian/Ubuntu | x86-64 | Hosted gateway topology | **Verified** (live beta gateway) |
| Bazzite / Steam Deck-class | x86-64 | Rootless user service | **Pending** (#663) |
| Raspberry Pi 5-class | aarch64 | Rootless user service | **Pending** — real-device verification required before any claim |
| Self-hosted gateway (production-equivalent) | x86-64 | Docker Compose | **Verified** (deploy + migration + health workflow) |
| LAN direct / remote direct ICE / forced TURN relay | any | any | **Verified** (health modes + turn-probe + multiplayer matrix) |

Everything outside this table (Fedora generally, Arch/Manjaro, additional ARM
devices, other reverse-proxy/container topologies) is post-beta work (#705).

---

## 7. Document map

- **[QUICKSTART.md](../QUICKSTART.md)** — role picker and the fastest path.
- **[SC-SERVER-INSTALL.md](SC-SERVER-INSTALL.md)** — host install/upgrade/
  uninstall, managed system service, troubleshooting detail.
- **[DEPLOY.md](DEPLOY.md)** — gateway deployment and migrations.
- **[STUN-TURN-ICE.md](STUN-TURN-ICE.md)** — coturn configuration reference.
- **[self-hosting-multiplayer.md](self-hosting-multiplayer.md)** — health modes
  and the fast-fix map.
- **[configuration.md](configuration.md)** — all runtime variables
  (`GV_*`, `[rom]`, `[cores]`, `[dat]`, environment overrides).
- **[.env.example](../.env.example)** — every environment variable with
  defaults.
- `sc-web/tests/multiplayer/README.md` — scenario matrix and evidence
  checklist for multiplayer failures.
