# STUN, TURN & ICE Setup Guide

**Self-hosting Sprite Cloud means running a WebRTC gateway.**  
This guide covers everything you need so peers can connect through NATs, firewalls,
and Docker containers — the stuff that makes you mutter *"this is bananas."*

> The canonical operator journey (which machine gets what, symptom-first
> troubleshooting, and the plain-language explainer) is
> **[SELF-HOSTING.md](SELF-HOSTING.md)**. This page is the coturn
> configuration reference.

---

## Quick Reference: What Goes Where

```
┌──────────────────────────────────────────────────────┐
│  Gateway server                                      │
│    ├─ coturn         :3478  (STUN + TURN)            │
│    ├─ Docker bridge  :172.17.0.1                     │
│    │   └─ sc-web container                           │
│    │       └─ Next.js on :3000                       │
│    └─ Firewall: UDP 3478, UDP 49152-65535            │
├──────────────────────────────────────────────────────┤
│  Game host (the machine with the ROMs)               │
│    └─ sc-server (systemd service or foreground)      │
└──────────────────────────────────────────────────────┘
```

`sc-server` runs on the game host, not inside the gateway container. The
browser (player) and `sc-server` (host) are the two WebRTC peers; the gateway
only relays commands/signaling and (optionally) hosts TURN.

---

## 1. Understanding WebRTC & ICE

WebRTC connects two peers (browser ↔ sc-server) directly whenever possible.
ICE (Interactive Connectivity Establishment) tries three strategies to make that
happen:

| Candidate Type | How It Works | Requires |
|---|---|---|
| **host** | Direct connection using local IPs | Same network (LAN) |
| **srflx** (server reflexive) | STUN tells each peer its public IP:port | STUN server reachable by both peers |
| **relay** | TURN server relays ALL traffic | TURN server with UDP port range |

The browser and sc-server gather all three types of candidates, exchange them via
SDP, and ICE tries every pair until one works.  **If TURN isn't configured, peers
behind symmetric NATs or CGNAT cannot connect at all.**

---

## 2. STUN — The Easy Part

STUN is a lightweight protocol. The peer sends a binding request, and the STUN
server replies with the peer's public IP and port. No relay, no credentials required.

**Use Google's public STUN servers:**

```
stun:stun.l.google.com:19302
stun:stun1.l.google.com:19302
```

Set via environment variable (in `docker-compose.yml`):

```yaml
GV_ICE_STUN_URLS: stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302
```

That's it. STUN is zero-config beyond this line.

---

## 3. TURN — The Hard Part

TURN (Traversal Using Relays around NAT) is the fallback when STUN fails.
A TURN server relays all media traffic between peers, adding latency but
guaranteeing connectivity through any firewall.

### 3.1 Install coturn

```bash
apt install coturn
```

### 3.2 Configure coturn (`/etc/turnserver.conf`)

```ini
# Listen on all interfaces, port 3478
listening-port=3478

# Your server's public IP (coturn needs to know this)
external-ip=YOUR_SERVER_IP

# Relay ports: coturn allocates from this range for each peer
min-port=49152
max-port=65535

# Long-term credentials
user=gv:your-secure-password-here
realm=sprite-cloud

# Use fingerprint for compatibility
fingerprint

# Enable both UDP and TCP relay
# (UDP is required for WebRTC media; TCP is a fallback)
no-tcp-relay

# Do NOT use loopback peers (security / prevents hairpin issues internally)
no-loopback-peers

# Log to syslog
syslog
```

### 3.3 Firewall Rules

Open these ports on your server:

```bash
# STUN + TURN control
ufw allow 3478/udp
ufw allow 3478/tcp

# TURN relay ports (the range you configured above)
ufw allow 49152:65535/udp
```

### 3.4 Environment Variables for Sprite Cloud

Set these in your `docker-compose.yml` under the sc-web service:

```yaml
environment:
  # STUN servers (Google public STUN)
  GV_ICE_STUN_URLS: stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302

  # TURN server URL — SEE SECTION 3.5
  GV_ICE_TURN_URLS: turn:172.17.0.1:3478

  # Long-term credentials (must match coturn's user= line)
  GV_ICE_TURN_USERNAME: gv
  GV_ICE_TURN_CREDENTIAL: your-secure-password-here
```

### 3.5 🔥 CRITICAL: TURN URL Inside Docker

**This is the #1 thing people get wrong.**  If sc-web runs inside Docker,
the TURN URL must use the Docker bridge gateway — **not** the public hostname.

```
❌ WRONG:  GV_ICE_TURN_URLS=turn:sprite-cloud.com:3478
✅ RIGHT:  GV_ICE_TURN_URLS=turn:172.17.0.1:3478
```

**Why:** From inside a Docker container, resolving your public hostname
(`sprite-cloud.com` → `YOUR_SERVER_IP`) sends packets out through Docker's NAT to
the public internet, then back to the same host.  This is **hairpin NAT** —
firewall rules and NAT tables often drop these packets silently.  Result:
the sc-server can't allocate TURN relays, and peers see ICE failures.

Using `172.17.0.1` (the Docker bridge gateway) connects directly to the host
without leaving the bridge.  The TURN server is reachable, allocations succeed,
and ICE works.

**Alternative:** if you use `host` networking mode for the container:
```yaml
network_mode: host
```
Then `turn:localhost:3478` or `turn:127.0.0.1:3478` works.  But `host` mode
breaks Docker's port isolation — we recommend the bridge approach.

---

## 4. ICE Transport Policy

Controls which ICE candidates the sc-server collects and offers.

| Policy | Candidates | When to Use |
|---|---|---|
| `all` | host + srflx + relay | **Default. Always use this.** Gives ICE maximum options. |
| `relay` | relay only | When you want ALL traffic through TURN (privacy, no IP leaks). |

Set via environment:

```yaml
GV_ICE_TRANSPORT_POLICY: all   # default — OK to omit
```

---

## 5. LAN Direct Connection (Optional)

If peers are on the same local network as the sc-server (e.g., streaming from
a gaming PC on your home LAN to a laptop in the next room), you can skip TURN
entirely for lower latency.

Set your LAN subnet IPs:

```yaml
GV_SERVER_LAN_IPS: 192.168.1.0/24,10.0.0.0/8
```

When a peer's IP matches one of these ranges, sc-server builds a fresh PC with
`All` transport policy and STUN only — no TURN needed.  LAN peers connect
directly.

---

## 6. Verifying Your Setup

### 6.1 Check coturn is running

```bash
systemctl status coturn
ss -ulnp | grep 3478
```

### 6.2 Test STUN

From any machine with `stun-client`:

```bash
stun-client stun.l.google.com:19302
# Should print your public IP and NAT type
```

### 6.3 Test TURN allocation

Use the WebRTC samples trickle-ice page:
https://webrtc.github.io/samples/src/content/peerconnection/trickle-ice/

Enter:
- STUN/TURN URL: `turn:your-server.com:3478`
- Username: `gv`
- Credential: `your-secure-password`

Click **Gather candidates**.  You should see:
- `host` candidates (local IPs)
- `srflx` candidates (public IP via STUN)
- `relay` candidates (TURN allocation) — this one proves TURN works

### 6.4 Operator probe: forced relay allocation from any network

`scripts/turn-probe.mjs` is a zero-dependency operator tool that performs a
real TURN Allocate (RFC 5766) against the configured relay from wherever it
is run — a laptop, a cellular hotspot, or another datacenter. It proves the
listener is reachable, the long-term credential is accepted, and a relay
allocation is granted, and prints sanitized evidence:

```bash
GV_ICE_TURN_URLS=turn:your-server.com:3478 \
GV_ICE_TURN_USERNAME=gv \
GV_ICE_TURN_CREDENTIAL=your-secure-password \
node scripts/turn-probe.mjs
```

Expected output (successful relay):

```json
{
  "url": "turn:your-server.com:3478?transport=udp",
  "state": "relayed",
  "probed_at": "2026-08-02T16:09:42.911Z",
  "latency_ms": 98,
  "relay_family": "ipv4"
}
```

Exit code is `0` when relayed, `1` on any failure. The credential is never
printed, and the evidence contains no secrets. The same probe runs
automatically in `/api/health` (see §8.4).

### 6.5 Check sc-web logs

```bash
docker logs sc-web-sc-web-1 2>&1 | grep -E '\[SDP\]|\[ICE\]|\[POOL\]|\[PREWARM\]'
```

Healthy output:
```
[PREWARM] ICE gathering complete in 2.3s
[PREWARM] done in 2.3s — TURN allocations held for first peer
[POOL] initialized with 4 pre-built stacks (target 4)
```

### 6.5 Browser WebRTC internals

In Firefox, navigate to `about:webrtc`.  Under the active peer connection,
check that:
- ICE state is `connected` (not `failed`)
- At least one candidate pair shows `nominated: true`
- `bytesReceived` and `bytesSent` are > 0

---

## 7. Common Issues

| Symptom | Likely Cause | Fix |
|---|---|---|
| ICE fails, relay candidate missing | TURN server unreachable from inside Docker | Use `turn:172.17.0.1:3478` |
| ICE fails, all pairs stuck "in-progress" | TURN credentials wrong | Check `GV_ICE_TURN_USERNAME` and `GV_ICE_TURN_CREDENTIAL` match coturn's `user=` line |
| First connection slow (25-30s) | No ICE pre-warming | sc-server handles this automatically — check `[PREWARM]` in logs |
| Reconnect after refresh fails | Session cancelled before ICE re-establishes | Fixed in sc-web ≥ 2026-06-28. Update to latest. |
| Guest can't connect | coturn's `relay-ip` wrong or port range blocked | Verify firewall rules for UDP 49152-65535 |
| "allocation mismatch" in coturn logs | Multiple peers behind same NAT conflict | Add `no-loopback-peers` to coturn config |
| Hairpin NAT drops packets | Container uses public hostname for TURN | Use Docker bridge gateway (Section 3.5) |

---

## 8. Production Checklist

- [x] coturn installed and running as a systemd service
- [x] Firewall: UDP 3478 + UDP 49152-65535 open
- [x] `GV_ICE_TURN_URLS` set to the public coturn hostname (`turn:sprite-cloud.com:3478?transport=udp`)
- [x] `GV_ICE_TURN_USERNAME` and `GV_ICE_TURN_CREDENTIAL` match coturn config
- [x] `GV_ICE_STUN_URLS` set to Google STUN servers
- [x] `GV_ICE_TRANSPORT_POLICY: all` (or omitted)
- [ ] `GV_SERVER_LAN_IPS` set if you have LAN peers
- [x] Verified with the operator probe: `node scripts/turn-probe.mjs` → `"state": "relayed"`
- [x] `/api/health` reports `turn_state: relayed` (live probe proof)
- [x] `/api/ice-config` advertises both STUN and TURN with credentials
- [x] Old/exposed credential rotated out and confirmed dead (probe → 401)

### 8.3 Credential rotation runbook (performed 2026-08-02)

Rotated the exposed coturn long-term credential end-to-end:

1. Generate: `openssl rand -hex 32` → keep in a 0600 temp file, never print it.
2. coturn (`/etc/turnserver.conf`): `sed -i -E "s|^user=guest:.*|user=guest:${NEW}|"` → `systemctl restart coturn`.
3. Game VPS systemd unit: **replace the whole `Environment="GV_ICE_TURN_CREDENTIAL=..."` line** — a greedy `.*` inside the line eats the closing quote (`s|(GV_ICE_TURN_CREDENTIAL=).*|\1${NEW}|` mangles the unit file, prewarm then fails with `turn server credentials required`). Use `s|^Environment=.*GV_ICE_TURN_CREDENTIAL.*|Environment="GV_ICE_TURN_CREDENTIAL=${NEW}"|` → `systemctl daemon-reload` + `systemctl restart sc-server`. Verify the line is exactly `Environment="GV_ICE_TURN_CREDENTIAL=<64-hex>"` (100 chars) before reloading.
4. Gateway: rewrite the `GV_ICE_*` block in `/root/sc-deploy/.env`, then **`docker compose up -d web`** — plain `restart` does NOT re-read `env_file`.
5. Verify: probe with new credential → `relayed`; probe with old credential → `401`; `/api/health` → `turn_state: relayed`; `/api/ice-config` → TURN advertised.
6. `shred -u` the temp credential file.

### 8.1 TURN credentials are secrets

The TURN credential is a relay credential: anyone holding it can request relay
allocations and consume relay bandwidth. Treat it like a password:

- **Never** commit a real credential to source. `scripts/install.sh` requires
  explicit `GV_TURN_CREDENTIAL` injection and `tests/no-tracked-turn-credentials.sh`
  (run in CI) rejects literal credentials in tracked installer/config sources.
- **Rotate** the credential on any suspicion of exposure (it has appeared in
  git history, chat logs, or issue comments).
- The credential is delivered to browsers via `/api/ice-config` so they can
  authenticate to coturn — this is the intended TURN consumption path, not a
  leak. It must never appear in health output, logs, screenshots, or issue
  comments.

### 8.2 Expected relay capacity for 5–10 testers

For the September limited beta (5–10 concurrent testers, retro consoles at
up to 480p/60fps):

| Resource | Estimate | Headroom at 10 testers |
|---|---|---|
| Per-session relay bandwidth | 0.5–3 Mbps (video) + ~0.1 Mbps (audio/input) | ~30 Mbps peak worst-case |
| coturn process count | 1 | fits a 2 vCPU VPS |
| UDP port range | 49152–65535 (16k ports) | ~1,600 sessions; ample |
| Memory | ~10–20 MB per 100 allocations | negligible |

A 1 Gbps VPS NIC with default coturn settings comfortably supports the cohort
with >30× headroom. Monitor with `ss -s`, `vnstat`, or Grafana; alert if relay
bandwidth exceeds ~100 Mbps or if `turnserver` restarts.

### 8.3 Alerting for TURN failure

`GET /api/health` now includes a `turn` component that fails closed:

- `components.turn.status: "ok"` — relay allocation verified by a live probe.
- `components.turn.status: "degraded"` — listener reachable but allocation not
  yet proven (e.g. credentials missing or probe pending).
- `components.turn.status: "error"` — probe failed (listener down, firewall
  block, or rejected credentials). The endpoint returns **503** and overall
  status becomes `error`.

Alert on any of these conditions with standard uptime monitoring:

```bash
# UptimeRobot / Grafana / cron: fail when TURN readiness is not proven
curl -fsS https://your-host/api/health | jq -e '.components.turn.status == "ok"'
```

The probe runs inside the health handler with a 60s success / 15s failure
cache TTL, so it detects relay outages within ~15 seconds of a failure while
staying cheap on the happy path. On outage, verify coturn (`systemctl status
coturn`), firewall (`ss -ulpn | grep 3478`), and credential match before
admitting testers.
- [ ] Verified with trickle-ice page (`about:webrtc` in Firefox)
- [ ] sc-web logs show `[PREWARM]` and `[POOL]` lines

---

## 9. Minimal Working docker-compose.yml

```yaml
services:
  sc-web:
    image: sc-web-prod:latest
    ports:
      - "3000:3000"
    environment:
      # STUN
      GV_ICE_STUN_URLS: stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302
      # TURN — use Docker bridge gateway, not public hostname
      GV_ICE_TURN_URLS: turn:172.17.0.1:3478
      GV_ICE_TURN_USERNAME: gv
      GV_ICE_TURN_CREDENTIAL: your-password-here
      # LAN direct (optional)
      GV_SERVER_LAN_IPS: 192.168.1.0/24
      # Other required env vars
      GV_WEB_URL: https://your-domain.com
      DATABASE_URL: postgres://...
      NEXTAUTH_SECRET: ...
    restart: unless-stopped
```

---

## 10. Why This Is Bananas

WebRTC is a peer-to-peer protocol designed for browsers — it wasn't built for
server-side media streaming.  Here's what makes it painful:

1. **ICE candidate gathering is asynchronous and slow.**  STUN lookups and TURN
   allocations take 2-5 seconds each.  sc-server pre-warms and pools PCs to hide
   this latency, but it adds complexity.

2. **Docker + TURN = hairpin NAT hell.**  Containers can't reach the host's
   public IP reliably.  You must either use the Docker bridge gateway, host
   networking, or a separate TURN server outside the container.

3. **NAT types are unpredictable.**  Symmetric NAT assigns a different public
   port for each destination, making STUN useless.  CGNAT (carrier-grade NAT)
   means multiple households share one public IP.  You NEED TURN for these.

4. **Debugging is opaque.**  When ICE fails, browsers show "ICE failed" with no
   details.  Use `about:webrtc` in Firefox or `chrome://webrtc-internals` in
   Chrome to see candidate pairs and connectivity state.

5. **The spec is massive.**  ICE alone is RFC 8445 (100+ pages).  Add STUN
   (RFC 8489), TURN (RFC 8656), and SDP (RFC 8866), and you're looking at
   400+ pages of RFCs just to get video from point A to point B.

**If you read nothing else:** use `turn:172.17.0.1:3478` inside Docker,
not your public hostname.  That one line change fixed 90% of our connectivity
issues.
