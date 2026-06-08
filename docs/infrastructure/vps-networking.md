# VPS Production Networking

This document describes the service architecture and port layout on the production VPS (`lngnckr.tech`). It is the reference for how traffic flows from the public internet to the internal services.

> **No secrets are recorded here.** Secret values (TURN credentials, DB connection strings, API keys) live in:
> - `/etc/games-vault.env` on the VPS
> - `/etc/turnserver.conf` on the VPS
> - `/root/.hermes/secrets/vps-72.62.243.69.env` on the VAULT host machine (local SSH credential storage)

---

## Architecture (port layout)

```
Internet
   │
   ├── :80  ──▶ Traefik (HTTP → redirect to :8443)
   │
   ├── :443 ──▶ sslh ──▶ Traefik :8443 (HTTPS)
   │
   └── :5349──▶ Traefik (TCP passthrough) ──▶ coturn :5348 (TURN/TLS)

Internal
   ├── Traefik :8443 ──▶ games-vault :8090  (ASP.NET app)
   │                  └──▶ landing :8088    (static landing page)
   ├── coturn :5348      (TURN/TLS relay — internal only)
   └── coturn :3478      (TURN/UDP — internal, not publicly routed)
```

### Why this layout

- **Port 443** carries HTTPS to the web app. `sslh` detects TLS and forwards to Traefik.
- **Port 5349** carries TURN/TLS relay traffic. Traefik's TCP router passthrough delivers raw TLS to coturn.
- The corporate VPN blocks UDP and many ports. Port 443 is the safest bet. Port 5349 is the fallback.
- Both ICE server URLs are advertised to the browser: `turns:lngnckr.tech:443?transport=tcp` and `turns:lngnckr.tech:5349?transport=tcp`.

---

## Services

### 1. Traefik (Docker)

- Runs in a Docker container with `host` networking.
- Image: `traefik:latest`
- Started via `docker compose` (check compose file location on host).
- **Entrypoints:**
  - `web` (:80) — redirects to `websecure`
  - `websecure` (:8443) — serves HTTPS for `lngnckr.tech`
  - `turn` (:5349) — TCP passthrough to coturn
- **Dynamic config:** `/docker/traefik/dynamic/lngnckr.yml` (bound into container at `/dynamic/`)
- **Let's Encrypt storage:** Docker volume `traefik_traefik-letsencrypt` at `/var/lib/docker/volumes/traefik_traefik-letsencrypt/_data`
- **Cert resolver:** HTTP challenge on `web` entrypoint

#### Dynamic config summary

| Router | Rule | Entrypoint | Backend |
|---|---|---|---|
| `lngnckr-games-vault` | Host + specific path prefix | websecure | `games-vault` :8090 |
| `lngnckr-games-vault-static` | Host + broad path prefixes | websecure | `games-vault` :8090 |
| `lngnckr-landing` | Host (catch-all, low priority) | websecure | `landing` :8088 |
| `turn-relay` | HostSNI (TCP passthrough) | turn | `coturn` :5348 |

### 2. coturn (systemd — `coturn.service`)

- **Binary:** `/usr/bin/turnserver`
- **Config:** `/etc/turnserver.conf`
- **Listeners:**
  - `127.0.0.1:3478` — UDP/TCP (STUN + TURN)
  - `127.0.0.1:5348` — TLS (TURN only)
- **External relay IP:** static (VPS public IP)
- **Auth:** long-term credential mechanism (`lt-cred-mech`)
- **Realm:** `nosebleed`
- **TLS certs:** `/etc/turn/fullchain.pem` + `/etc/turn/privkey.pem` (Let's Encrypt)

### 3. sslh (systemd — `sslh.service`)

- **Config:** `/etc/default/sslh`
- **Role:** Multiplexes port 443. Currently configured to forward ALL TLS to Traefik on `127.0.0.1:8443`.
- **Limitation:** sslh cannot distinguish HTTPS from TURN/TLS by protocol (both are TLS). If TURN needs to share port 443, the approach must change (see [Stretch goals](#stretch-goals--known-limitations)).

### 4. games-vault (systemd — `games-vault.service`)

- **Binary:** `/opt/games-vault/games-vault` (published ASP.NET Core app)
- **Config:** `/etc/games-vault.env` (EnvironmentFile)
- **Systemd drop-ins:**
  - `/etc/systemd/system/games-vault.service.d/nosebleed.conf` — nosebleed paths and settings
- **Release marker:** `/opt/games-vault/RELEASE_COMMIT`
- **Deployment:** from VAULT via `scripts/deploy-prod-from-main.sh` (rsync to VPS)

### 5. nosebleed (spawned by games-vault)

- **Binary:** `/opt/nosebleed/nosebleed`
- **Release marker:** `/opt/nosebleed/RELEASE_COMMIT`
- **Cores:** `/srv/storage/games-vault/nosebleed/cores/`
- **Sessions:** `/srv/storage/games-vault/nosebleed/sessions/`
- Launched per-session by games-vault's `NosebleedSessionManager`. Not a long-running daemon.

### 6. Landing page (systemd — python script)

- **Binary:** `/usr/local/bin/lngnckr-landing.py`
- **Serves:** minimal static page on `127.0.0.1:8088`
- **Role:** catch-all for unhandled routes at `lngnckr.tech`

---

## ICE server configuration

Configured in two places:

1. **Nosebleed** (`server.rs`, `MediaConfig::default_ice_servers()`):
   - STUN: `stun:stun.l.google.com:19302`, `stun:stun1.l.google.com:19302`
   - TURN: `turns:lngnckr.tech:443?transport=tcp`, `turns:lngnckr.tech:5349?transport=tcp`
2. **Games Vault** (`server-player.js`):
   - Same ICE server list, passed as fallback / override

Credentials use long-term auth mechanism with realm `nosebleed`. The actual credential is stored in `/etc/turnserver.conf`.

---

## Certificates (Let's Encrypt)

Two copies of the cert exist:

| Location | Used by | Renewal |
|---|---|---|
| Docker volume `traefik_traefik-letsencrypt` | Traefik (auto-managed) | Automatic via Traefik ACME |
| `/etc/turn/fullchain.pem` + `privkey.pem` | coturn | **Manual** — must be copied from Traefik's volume on renewal |

> **⚠️ The `/etc/turn/` cert is NOT auto-renewed.** If the cert expires, TURN connections will fail. Set up a cron job or post-renew hook to copy from Traefik's ACME storage.

---

## Security notes

- **coturn binds to `127.0.0.1` only** — not exposed to the public internet directly. All public TURN traffic arrives via Traefik's TCP proxy on port 5349.
- **sslh binds to `0.0.0.0:443`** — this is the only publicly accessible port besides Traefik's 5349.
- **games-vault binds to `127.0.0.1:8090`** — never exposed directly.
- TURN credentials use long-term mechanism. Rotate periodically.

---

## Relevant files (on VPS)

| Path | Purpose |
|---|---|
| `/etc/turnserver.conf` | coturn server configuration |
| `/etc/default/sslh` | sslh daemon options |
| `/docker/traefik/dynamic/lngnckr.yml` | Traefik route definitions |
| `/etc/games-vault.env` | games-vault environment (secrets) |
| `/etc/systemd/system/games-vault.service` | games-vault unit file |
| `/etc/systemd/system/games-vault.service.d/nosebleed.conf` | nosebleed env overrides |
| `/opt/nosebleed/RELEASE_COMMIT` | deployed nosebleed commit |
| `/opt/games-vault/RELEASE_COMMIT` | deployed games-vault commit |
| `/root/.hermes/secrets/vps-72.62.243.69.env` | SSH credentials (VAULT host only) |

---

## Stretch goals & known limitations

1. **Port 443 cannot currently serve TURN.** sslh routes all TLS to Traefik. To share port 443 between HTTPS and TURN, a subdomain approach is needed:
   - Add DNS A record `turn.lngnckr.tech` → same VPS IP
   - Get a Let's Encrypt cert covering both domains
   - Replace sslh with SNI-based routing (haproxy or nginx TCP proxy)
   - Route `turn.lngnckr.tech` → coturn :5348, `lngnckr.tech` → Traefik :8443
   - Update ICE URLs to use `turn.lngnckr.tech:443`

2. **ALPN-based routing (haproxy `req.ssl_alpn`) was attempted but did not work** because `req.ssl_alpn` fetcher in haproxy 2.8 TCP mode cannot reliably distinguish TURN ALPN from HTTP ALPN on a non-SSL bind. SNI routing is the correct solution.

3. **Haproxy was briefly installed and removed** during the ALPN experiment. A stale config may remain if not cleaned up (`/etc/haproxy/haproxy.cfg`).
