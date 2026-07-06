# ADR 0001: Guest Multiplayer Transport Strategy

Status: Accepted
Date: 2026-07-06
Issue: #521
Epic: #515

## Context

Sprite Cloud currently uses WebRTC for browser/game streaming and guest multiplayer. The recent audit and follow-up fixes improved runtime parity, removed unreliable gateway-side LAN inference, unified browser bootstrap, normalized signaling, and added a scenario verification matrix.

That still leaves a product-level decision:

> Should guest multiplayer remain WebRTC-native in the current topology-sensitive form, or should the project prefer a more deterministic relayed path for guests?

This matters because Sprite Cloud is a self-hosted product aimed at non-expert users. A transport that works only when the operator understands NAT/STUN/TURN behavior is not sufficient.

## Evidence from the current codebase

### gv-server transport facts

- `gv-server/src/webrtc.rs`
  - `ice_config()` loads shared runtime STUN/TURN config.
  - `build_pc_for_guest()` includes both STUN and TURN and uses the configured ICE transport policy.
  - `build_session_pc_lan()` exists as a special-case direct/LAN host path.
  - `exchange_sdp()` must wait for ICE gathering and explicitly sleeps to allow relay candidates to make it into the SDP answer.

### gv-web transport facts

- `gv-web/app/api/ice-config/route.ts`
  - browser ICE policy is now config-driven only.
  - gv-web intentionally does **not** guess LAN topology from request IPs.
- `gv-web/app/api/server/command/route.ts`
- `gv-web/app/api/server/notify/route.ts`
- `gv-web/app/api/room/join/route.ts`
  - signaling phases are now explicit and consistently logged.

### Verification facts

- `gv-web/tests/multiplayer/README.md`
- `gv-web/lib/multiplayer-verification-matrix.ts`
  - scenario 1 is readily automatable.
  - scenarios 2–4 still depend on real network topology and log capture.
- Same-machine host+guest smoke testing now passes.

## Decision drivers

We evaluated options against:

- installability for non-expert self-hosters
- reliability across scenarios 1–4
- latency/performance tradeoffs
- implementation complexity
- operational burden
- debugging/observability burden

## Options considered

### Option 1 — Keep the current WebRTC model and harden it

Meaning:
- host and guest both continue using the current WebRTC negotiation model
- direct vs relay remains ICE-policy/topology dependent
- engineering work focuses on better defaults, better logs, and bug fixes

Pros:
- minimal architectural churn
- preserves best-case direct-path latency
- reuses current media/data-channel design

Cons:
- self-hosting success still depends on topology-sensitive behavior
- support/debugging burden remains high for scenarios 2–4
- operators still need correct TURN rollout on both gv-web and gv-server
- the product remains vulnerable to hostile-NAT/cellular edge cases

Conclusion:
- not sufficient as the long-term guest multiplayer strategy

### Option 2 — Keep WebRTC for host media, but make guest multiplayer use a deterministic relayed path by default

Meaning:
- continue using WebRTC media + data channels
- keep direct/local optimization available for host and explicitly local scenarios
- treat guest multiplayer as **relay-first / deterministic** rather than opportunistic direct connectivity
- prefer a single debuggable route for guests over topology-sensitive route selection

Pros:
- preserves the existing streaming/media stack
- reduces scenario variance for guests
- keeps latency reasonable while making remote success more predictable
- much easier to document and support for non-expert self-hosters
- aligns with current architecture better than a full transport rewrite

Cons:
- higher bandwidth/relay cost when direct would have worked
- some direct-path performance is intentionally traded away for predictability
- still depends on TURN or another relay substrate being healthy and observable

Conclusion:
- **chosen**

### Option 3 — Replace guest multiplayer transport entirely with a server-mediated non-WebRTC path

Meaning:
- guests would no longer use the current WebRTC guest path
- a new relay/transport model would be introduced for guest input/media/session attachment

Pros:
- could become maximally deterministic
- could significantly reduce NAT sensitivity if designed around a single server-mediated transport

Cons:
- largest implementation cost by far
- duplicates or replaces major parts of the current streaming stack
- highest migration and correctness risk
- delays product stabilization while the system is re-architected

Conclusion:
- too expensive and disruptive for the current stage of the project
- can be revisited only if option 2 fails to deliver acceptable reliability

## Decision

**Adopt option 2:**

> Keep WebRTC as the media/session transport, but make guest multiplayer deterministic by preferring a relayed/server-mediated guest path by default.

In practice, this means:

- host path may still use direct/local optimization where explicitly justified
- guest path should no longer rely on best-effort topology luck as the default success mode
- guest transport behavior should be understandable from config + logs alone
- self-hosters should be able to get reliable guest multiplayer without understanding ICE internals

## Why this decision fits Sprite Cloud now

This choice best matches the current codebase and product constraints:

1. It preserves the existing WebRTC/media investment.
2. It reduces the user-facing complexity where the product is currently weakest: guest multiplayer across real networks.
3. It turns guest success into an infrastructure/observability problem instead of a topology-guessing problem.
4. It gives the project a clear fallback if direct optimization remains too fragile.

## Observability requirements

This decision is not just about route selection. It requires first-class observability.

### Required logs/evidence

For every guest multiplayer failure, operators must be able to collect:

- browser logs
  - bootstrap path
  - signaling flow/stage
  - selected candidate pair / route classification
  - data-channel state
- gv-web logs
  - command/session IDs
  - room join resolution
  - notify / SDP answer resolution
- gv-server logs
  - `host_start`, `guest_offer`, `host_reconnect` stages
  - session missing / fresh-PC / SDP failures
- relay logs
  - coturn allocation/auth failures or equivalent relay-substrate evidence

### Product requirement

A self-hoster must be able to answer:

- did the guest attempt direct or relay?
- which route actually won?
- where did negotiation fail?
- was relay unavailable, misconfigured, or merely not selected?

without reading both browser and server source side-by-side.

## Consequences

### Positive

- better reliability for scenarios 2–4
- more supportable self-hosting story
- clearer docs and triage procedures
- lower debugging ambiguity

### Negative

- guest path may sacrifice some best-case latency
- TURN/relay uptime becomes more central
- relay cost/bandwidth becomes a clearer operational consideration

## Follow-up implementation plan

1. **Make guest transport policy explicit**
   - introduce an explicit guest-transport mode instead of relying on incidental ICE outcomes
   - document the default as deterministic relay-first behavior for guests

2. **Separate host optimization from guest determinism**
   - keep host/local direct-path optimizations isolated
   - avoid leaking host/LAN special cases into the default guest path

3. **Improve route reporting**
   - surface selected guest route clearly in browser + gv-web + gv-server logs
   - make relay selection/failure obvious in operational evidence

4. **Codify the self-hosting story**
   - document the minimal working deployment for reliable guest multiplayer
   - make relay requirements explicit and testable

5. **Re-evaluate only if needed**
   - if relay-first guest multiplayer still fails to meet reliability goals, revisit option 3 with concrete failure data

## Non-goals

This ADR does **not** immediately:
- replace WebRTC
- remove host direct-path support
- commit the project to a specific non-WebRTC transport rewrite

It sets the architectural direction for guest multiplayer so follow-up work can be judged against a clear standard.

## Supersession rule

Any future proposal to restore opportunistic direct guest connectivity as the default must show evidence that it does not reintroduce the self-hosting/debugging burden identified in #515.
