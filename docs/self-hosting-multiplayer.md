# Self-hosting multiplayer without WebRTC expertise

This is the operator guide for issue #522.

Goal: answer the question *"is my Sprite Cloud multiplayer setup healthy?"* without making you reason about STUN, TURN, ICE, or NAT internals.

## The 4 modes Sprite Cloud can be in

### 1. LAN-only

What it means in product terms:
- same-machine and same-LAN play may work
- remote guest reliability is **not** guaranteed

Typical health output:
```json
{
  "mode": "lan-only",
  "transport_policy": "all",
  "stun_configured": false,
  "turn_configured": false,
  "turn_ready": false,
  "diagnostics": [
    "No STUN/TURN URLs configured — browser falls back to default STUN (stun:stun.l.google.com:19302).",
    "Mode is suitable for LAN or friendly-NAT testing only; remote guest reliability is not guaranteed."
  ]
}
```

When this is acceptable:
- only local/LAN testing
- you do not care about guests joining from other networks

### 2. STUN-capable

What it means in product terms:
- friendly home-network guests may work
- hostile NAT / cellular guests may still fail

Typical health output:
```json
{
  "mode": "stun-capable",
  "transport_policy": "all",
  "stun_configured": true,
  "turn_configured": false,
  "turn_ready": false,
  "diagnostics": [
    "STUN is configured but TURN is not — friendly-NAT play may work, hostile-NAT/cellular guests may fail.",
    "Add TURN credentials if you want reliable remote guest multiplayer."
  ]
}
```

### 3. TURN-capable

What it means in product terms:
- this is the recommended mode for reliable remote guest multiplayer
- the system has a deterministic relay path available

Typical health output:
```json
{
  "mode": "turn-capable",
  "transport_policy": "all",
  "stun_configured": true,
  "turn_configured": true,
  "turn_ready": true,
  "diagnostics": [
    "TURN is configured.",
    "Transport policy is all, so browsers may use direct or relay candidates depending on topology."
  ]
}
```

### 4. Misconfigured

What it means in product terms:
- the relay looks configured at first glance
- but remote guest multiplayer is **not actually healthy**

Typical health output:
```json
{
  "mode": "misconfigured",
  "transport_policy": "all",
  "stun_configured": true,
  "turn_configured": true,
  "turn_ready": false,
  "diagnostics": [
    "TURN URL is configured but username/credential is missing — relay is not actually usable.",
    "Fix GV_ICE_TURN_USERNAME and GV_ICE_TURN_CREDENTIAL to make remote guest multiplayer reliable."
  ]
}
```

## The one command operators should know

Open:

- `https://your-gateway.example/api/health`

Look for the `connectivity` block.

That tells you, in product terms, whether multiplayer is:
- local/LAN only
- likely okay on friendly home internet
- ready for reliable remote guest play
- misconfigured

## Minimum viable setup for reliable guest multiplayer

If you want people outside your house/LAN to join reliably, aim for:

- `mode = turn-capable`
- `turn_ready = true`
- a real TURN hostname/port
- a real TURN username + credential
- successful scenario checks from `sc-web/tests/multiplayer/README.md`

## Fast fix map

| Health mode | What it means | What to do next |
|---|---|---|
| `lan-only` | only local/friendly testing is realistic | add STUN and TURN config |
| `stun-capable` | home-network guests may work, hostile NAT may fail | add TURN config |
| `turn-capable` | best current mode for remote guests | run the verification matrix and check logs on failure |
| `misconfigured` | TURN looks present but is unusable | fix TURN username/credential mismatch |

## Where to look when it still fails

If `/api/health` says `turn-capable` and guests still fail, capture:

1. browser logs
2. sc-web logs
3. sc-server logs
4. coturn logs

Use the matrix in `sc-web/tests/multiplayer/README.md` to decide which scenario failed and what evidence to attach.
