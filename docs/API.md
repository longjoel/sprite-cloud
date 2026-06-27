# API Reference

`gv-web` exposes the HTTP API used by the browser UI and paired `gv-server` hosts. All routes are under `/api`.

## Auth models

| Caller | Auth | Used for |
|---|---|---|
| Browser | Auth.js session cookie + CSRF on mutations | Dashboard, setup, library, play/share flows |
| Host runtime | `Authorization: Bearer <api-key>` | Pair verification, polling, command results, session updates |
| Pairing command | Short-lived pairing code | Initial host registration |

Secrets and bearer tokens are examples only in this document; never commit real values.

## Setup/auth

| Route | Method | Auth | Purpose |
|---|---:|---|---|
| `/api/auth/setup` | `POST` | setup code | Create the first admin account when no users exist |
| `/api/auth/signup` | `POST` | session/setup policy | Create a DB-backed user account |
| `/api/auth/[...nextauth]` | `GET/POST` | Auth.js | Sign-in/sign-out/session handling |
| `/api/auth/verify` | `GET` | host bearer | Validate a paired host API key |

### Pairing

| Route | Method | Auth | Purpose |
|---|---:|---|---|
| `/api/auth/pair/generate` | `POST` | browser session | Generate a short-lived pairing code |
| `/api/auth/pair/claim` | `POST` | pairing code | Exchange a pairing code for `server_id` + API key |

Claim request:

```json
{ "code": "ABCD-EFGH" }
```

Claim response:

```json
{
  "server_id": "00000000-0000-0000-0000-000000000000",
  "api_key": "gvsk_example"
}
```

## Host command relay

| Route | Method | Auth | Purpose |
|---|---:|---|---|
| `/api/server/poll` | `POST` | host bearer | Return pending commands for a paired host |
| `/api/server/result` | `POST` | host bearer | Submit command completion/failure payloads |
| `/api/server/command` | `POST` | browser session | Queue a command for a selected host |
| `/api/commands/[id]/result` | `GET` | browser session | Poll a queued command result by command ID |
| `/api/server/notify` | `GET/POST` | browser/session or host bearer | Legacy-compatible session readiness endpoint |
| `/api/server/launch-event` | `POST` | host bearer | Report launch lifecycle events |
| `/api/admin/launch-timeline` | `GET` | browser session | Inspect recent launch/session events |
| `/api/server/ws` | `GET` | browser/session | WebSocket/SSE-style server updates where enabled |

Command payloads are JSON objects with a `type`, `server_id`, and type-specific `payload`. Current host command families include:

- `start_game`
- `stop_game`
- `sdp_offer`
- `browse_files`
- `scan_paths`

## Server and library management

| Route | Method | Auth | Purpose |
|---|---:|---|---|
| `/api/servers/members` | `GET` | browser session | List servers available to the signed-in user |
| `/api/servers/[server_id]` | `GET/PATCH/DELETE` | browser session | Read/update/remove a server registration |
| `/api/servers/[server_id]/metadata` | `GET/PATCH` | browser session | Read/update host metadata |
| `/api/servers/[server_id]/rom-roots` | `GET/PATCH` | browser session | Configure visible ROM roots |
| `/api/library/import` | `POST` | browser session | Import scan results into the library |
| `/api/games/[id]` | `GET` | browser session | Fetch one game record |
| `/api/playable-hosts` | `GET` | browser session | Return hosts that can play a selected game |

## Rooms/share links

| Route | Method | Auth | Purpose |
|---|---:|---|---|
| `/api/room/share` | `POST` | browser session | Create a room/share token for a session |
| `/api/room/join` | `POST` | room token/session | Join an existing room |
| `/api/room/resolve/[code]` | `GET` | optional session | Resolve a short share code |
| `/api/room/shorten` | `POST` | browser session | Create a short code for a room/session URL |

## Runtime config/health

| Route | Method | Auth | Purpose |
|---|---:|---|---|
| `/api/health` | `GET` | none | Gateway health/status check |
| `/api/ice-config` | `GET` | none/session-safe | Return STUN/TURN config for browser WebRTC setup |

Example ICE response:

```json
{
  "iceServers": [
    { "urls": "stun:stun.l.google.com:19302" }
  ],
  "iceTransportPolicy": "all"
}
```

## Compatibility terminology

Some response fields still use `worker_*` names, especially `worker_token`, for compatibility with older client/server code. In current deployments those values identify a host-runtime play session inside `gv-server`; they do not imply a separate runtime binary.
