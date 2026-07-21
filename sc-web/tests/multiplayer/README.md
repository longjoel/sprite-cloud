# Multiplayer Verification Matrix

This runbook is the acceptance checklist for issue #520 and the multiplayer audit epic #515.

Use it after signaling/bootstrap changes and before claiming multiplayer regressions are fixed.

## How to use this file

1. Run the automated checks for scenario 1.
2. Run the manual scenarios for 2–4 when environment/topology is available.
3. Attach the required evidence for every scenario.
4. If a scenario fails, capture the listed logs before retrying.

## Automated baseline

Run these first:

```bash
pnpm vitest run tests/api/routes.test.ts tests/multiplayer/matrix.test.ts
pnpm run test:integration
pnpm run lint
pnpm run build
cargo check -p sc-server
```

Why this exists:
- `tests/api/routes.test.ts` covers host start, guest room join, guest peer reuse, and notify behavior.
- `tests/multiplayer/matrix.test.ts` enforces that the 4 intended multiplayer scenarios stay documented with explicit evidence + log requirements.
- `tests/integration/lifecycle-db.test.ts` validates DB lifecycle transitions for sessions, commands, launch events, and peer tokens.

## Scenario matrix

### 1) Same machine / two browsers

**Goal**
- Catch regressions in canonical player bootstrap, room join, guest SDP, token reuse, and per-command SDP answer routing.

## Automation
- `pnpm vitest run tests/api/routes.test.ts tests/multiplayer/matrix.test.ts`
- `pnpm run test:integration`

## Notes
- `test:integration` spins up disposable Postgres in Docker via `tests/integration/test-db.ts`.
- `tests/integration/cleanup-db.test.ts` exercises the real `lib/db/cleanup.ts` path against Postgres, including FK-safe delete ordering and protection for old `pending` commands.

## Manual smoke

- Open guest link in a second browser profile on the same machine.
- Confirm both sides get media and guest input works.

**Pass evidence**
- Host launch succeeds and guest link resolves without 4xx/5xx.
- Selected transport route is visible in browser WebRTC stats / logs.
- Time to first guest frame is recorded.
- Media + data channel both succeed.

**Logs to capture on failure**
- Browser: `[gv]` bootstrap logs, `[SIGNAL]` flow/stage logs, WebRTC candidate pair + data channel state.
- sc-web: `/api/server/command`, `/api/room/join`, `/api/server/notify` logs with shared command/session IDs.
- sc-server: `[SIGNAL] flow=host_start|guest_offer|host_reconnect` logs.
- coturn: only if relay unexpectedly appears or TURN allocation errors show up.

### 2) Two remote browsers on friendly NATs

**Goal**
- Verify the common real-world guest case across normal home networks.

**Manual procedure**
- Host from one home network.
- Join from a second remote home network with the guest link.
- Record whether the path is direct or relayed and whether reconnect was needed.

**Pass evidence**
- Guest joins successfully from the remote home network.
- Route classification is captured from browser stats/logs.
- Guest connect time is measured.
- Media + data channel both succeed.

**Logs to capture on failure**
- Browser: host + guest bootstrap/signaling logs and ICE failures.
- sc-web: room join, command insert, notify, and SDP-answer resolution logs.
- sc-server: host_start / guest_offer stage logs and reconnect warnings.
- coturn: allocation/auth logs if relay is selected or should have been selected.

### 3) Same LAN as sc-server host

**Goal**
- Prove local-network operation works without the removed gateway-side LAN IP heuristic.

**Manual procedure**
- Use two devices on the same LAN as sc-server.
- Use the normal public site + guest link flow.
- Record the selected route and whether media/input stay stable.

**Pass evidence**
- Both LAN-local players connect without gateway-side LAN inference.
- Candidate pair / route classification is captured.
- Time to first frame is measured.
- Media + data channel both succeed.

**Logs to capture on failure**
- Browser: console logs + WebRTC stats from both LAN clients.
- sc-web: signaling-stage logs showing deterministic flow selection.
- sc-server: session/SDP stage logs for direct-path success or churn.
- coturn: allocation logs if TURN is unexpectedly selected.

### 4) Different networks including hostile NAT / cellular

**Goal**
- Prove the hardest connectivity case or capture an actionable failure record.

**Manual procedure**
- Join a host session from a guest device on cellular or another hostile-NAT network.
- Record whether the path succeeds directly, falls back to TURN, or fails.

**Pass evidence**
- Guest reaches a playable state from the hostile network.
- Evidence shows whether TURN relay was selected or negotiation failed first.
- Connect time and retry/reconnect behavior are recorded.
- Media + data channel both succeed.

**Logs to capture on failure**
- Browser: ICE failure logs, selected route stats, data-channel state.
- sc-web: full signaling-stage sequence and any timeout/missing-answer logs.
- sc-server: host_start / guest_offer / host_reconnect logs and SDP warnings.
- coturn: mandatory TURN allocation/auth logs.

## Triage rule

When a scenario fails, do **not** summarize from memory.
Attach:
- browser console logs
- sc-web logs
- sc-server logs
- coturn logs when relay was expected or observed
- measured route + time-to-connect evidence

That makes each regression comparable against the same checklist instead of guesswork.
