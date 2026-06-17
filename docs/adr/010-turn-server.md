# ADR 010: TURN server for remote play

**Status:** Accepted
**Date:** 2026-06-14

## Context

STUN works on LAN (both peers behind the same NAT, or direct IP reachable).
Remote play requires TURN relay when direct P2P fails (mobile networks,
corporate firewalls, double NAT). The worker currently uses Google's
public STUN — no TURN configured.

## Options

### A: coturn on Vault
- Self-hosted TURN/STUN server on the same machine as gv-server
- Full control, no usage limits, no subscription
- Requires UDP port range open on the router
- **Effort:** Medium (install coturn, configure, open firewall)

### B: Cloud TURN (Twilio, Xirsys, Metered)
- No infrastructure to manage
- Usage-based pricing (typically $0.01–0.05/GB)
- Limited free tiers
- **Effort:** Low (set `TURN_SERVER` env var)

### C: gv-server as relay
- gv-server proxies all WebRTC traffic
- No TURN needed at all
- Defeats P2P — all bandwidth through the server
- **Effort:** High (implement relay) + high server load

## Decision

**Option A — coturn on Vault, with cloud TURN as fallback.** The
`STUN_SERVER` env var already supports `turn:` URIs. Start with coturn
for LAN-adjacent play (dev + home use), fall back to a cloud TURN
provider for production if needed.

## Consequences

- Not blocking MVP — LAN-only play works with STUN alone.
- coturn config: single UDP port range (49152–65535), long-term credential
  mechanism, TLS for TURNS.
- The env var already supports multiple servers comma-separated.

## Deployment (2026-06-17)

coturn is deployed on the VPS relay at `72.62.243.69`:

- Package: `coturn` (apt)
- Listening: UDP 3478 (STUN/TURN), TLS 5348
- Realm: `nosebleed`
- Credential mechanism: long-term (lt-cred-mech)
- External/relay IP: `72.62.243.69`
- Certificates: Let's Encrypt via certbot, symlinked to `/etc/turn/`

### Configuration template

```conf
# /etc/turnserver.conf
listening-ip=127.0.0.1
listening-ip=<docker-bridge-ip>
listening-port=3478
tls-listening-port=5348
relay-ip=<public-ip>
external-ip=<public-ip>
lt-cred-mech
realm=nosebleed
user=<username>:<hashed-password>
cert=/etc/turn/fullchain.pem
pkey=/etc/turn/privkey.pem
fingerprint
no-stdout-log
log-file=/var/log/turnserver.log
simple-log
```

### Credential generation

```bash
# Add a long-term credential user
sudo turnadmin -a -u <username> -p <password> -r nosebleed
```

### Bandwidth notes

TURN relay routes all media through the VPS. At the default 500 kbps VP8
bitrate, one hour of play uses ~225 MB. Monitor VPS bandwidth and consider
rate-limiting or a cloud TURN fallback for production multi-user use.

### Firewall

Make sure UDP port 3478 (and the relay port range 49152–65535) is open on
the VPS firewall. The Docker bridge (172.17.0.0/16) should have access to
the TURN ports.

```bash
sudo ufw allow 3478/udp
sudo ufw allow 49152:65535/udp
```
