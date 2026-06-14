# ADR 010: TURN server for remote play

**Status:** Proposed
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
