# Security Model

Sprite Cloud's security model separates two distinct connection paths with
different trust levels.

## Connection paths

### 1. Gateway-relayed (authenticated)

```
Browser ──HTTPS──▶ sc-web (sprite-cloud.com) ──HTTPS──▶ sc-server ──▶ game
```

- All traffic flows through sc-web over HTTPS
- Browser sends session cookies and CSRF tokens
- sc-web validates: session auth → server membership → CSRF token
- Session cookies are `Secure` and `SameSite=Lax`
- This is the primary path for users on the public internet

### 2. LAN-direct (host-token bearer)

```
Browser ──HTTP──▶ sc-server:8787 (LAN player proxy) ──HTTPS──▶ sc-web ──▶ game
```

- The LAN player proxy runs on HTTP (no TLS on LAN)
- The browser cannot send Secure cookies over HTTP — no session auth possible
- Instead, a one-shot `host_token` is embedded in the URL fragment
- sc-web validates: `host_token` matches a short-code row → resolves server owner
- No session cookies, no CSRF tokens, no user identity on this path
- The `host_token` is a `crypto.randomUUID()` — 122 bits of entropy, single-use

## Threat model

### What LAN-direct trusts

- Anyone on the same LAN who knows the `host_token` can start a game
- The `host_token` is embedded in a URL fragment (not sent to the server in HTTP requests)
- URL fragments can leak through: browser history, server access logs (if fragment is sent), referrer headers, and screen sharing

### What LAN-direct does NOT trust

- The caller's claimed identity (resolved from the host_token's owner, not the caller)
- The caller's browser (no cookies checked)
- The network path (HTTP, no encryption)

## Mitigations

| Layer | Mechanism |
|---|---|
| Token entropy | `crypto.randomUUID()` — 122 bits, not guessable |
| Token lifetime | One-shot — consumed on first use, then invalid |
| Rate limiting | 30 requests/min per IP on all command endpoints |
| Server opt-out | `sc-server start --no-lan-player` disables LAN-direct entirely |
| Metadata reporting | `lan_player_enabled` reported to sc-web, visible in dashboard |

## Operator guidance

### When to disable LAN-direct

Disable LAN-direct (`sc-server start --no-lan-player`) when:
- The server is on an untrusted network (coffee shop, conference WiFi)
- You only want authenticated relay-based play
- You're running a public-facing server where LAN access is undesirable

### When LAN-direct is safe

LAN-direct is designed for:
- Home LANs behind NAT with trusted devices
- Local multiplayer sessions where all players are physically present
- The default configuration (enabled) is safe for home use

## Reporting vulnerabilities

Email joel@sprite-cloud.com. PGP key available on request.

Please do not file public issues for security vulnerabilities.
