# gv-web REST API Reference

gv-web is the Next.js 15 web application that handles authentication,
pairing, command queuing, and session management. All API routes live
under `/api/`.

**Base URL:** `http://<host>:<port>` (default: `http://localhost:3001`)

---

## Authentication

Two auth models:

| Model | How | Used by |
|-------|-----|---------|
| OAuth session | NextAuth.js session cookie | Browser (user signed in via GitHub or LAN creds) |
| API key bearer | `Authorization: Bearer gvsk_...` | gv-server (acquired during pairing) |

Endpoints specify which auth model they require.

---

## Endpoints

### POST /api/auth/pair/generate — Generate pairing code

Creates an 8-letter case-insensitive pairing code with a 5-minute TTL.
Used by the `/dev` dashboard.

**Auth:** OAuth session

**Request**
```
POST /api/auth/pair/generate
```

**Response** `200 OK`
```json
{ "code": "ABCD-EFGH" }
```

---

### POST /api/auth/pair/claim — Claim pairing code

Redeems a pairing code and returns an API key + server ID. Called by
`gv-server pair`.

**Auth:** None (the code itself is the credential)

**Request**
```
POST /api/auth/pair/claim
Content-Type: application/json
```
```json
{ "code": "ABCD-EFGH" }
```

**Response** `200 OK`
```json
{
  "api_key": "gvsk_a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6",
  "server_id": "a0000000-0000-0000-0000-000000000001"
}
```

**Error responses**
| Status | Body | Cause |
|--------|------|-------|
| `400 Bad Request` | `"Invalid code"` | Code not found |
| `400 Bad Request` | `"Code expired"` | Code older than 5 minutes |
| `400 Bad Request` | `"Code already claimed"` | Already used |

---

### GET /api/auth/verify — Verify server credentials

Validates that an API key is still active. Used by gv-server on startup
to confirm its credentials.

**Auth:** API key bearer

**Request**
```
GET /api/auth/verify
Authorization: Bearer gvsk_...
```

**Response** `200 OK`
```json
{ "valid": true, "server_id": "a0000000-..." }
```

**Error responses**
| Status | Body | Cause |
|--------|------|-------|
| `401 Unauthorized` | — | Missing or invalid API key |

---

### POST /api/server/command — Queue a command

Queues a command for a gv-server to execute. Generates a `worker_token`
for `start_game` commands so the browser can later poll for the worker URL.

**Auth:** OAuth session

**Request**
```
POST /api/server/command
Content-Type: application/json
```
```json
{
  "type": "start_game",
  "server_id": "a0000000-...",
  "payload": {
    "game_id": "snes_super_mario_world"
  }
}
```

**Response** `200 OK`
```json
{
  "id": "cmd_abc123",
  "worker_token": "tok_def456"
}
```

**Supported command types:**

| `type` | `payload` | Returns `worker_token`? |
|--------|-----------|------------------------|
| `start_game` | `{ game_id: string }` | Yes |
| `stop_game` | `{ game_id: string }` | No |

**Error responses**
| Status | Cause |
|--------|-------|
| `401 Unauthorized` | No valid session |
| `400 Bad Request` | Missing required fields |

---

### POST /api/server/poll — Poll for pending commands

Returns undelivered commands for a server. Commands are delivered once
via a cursor — a consumed command is never re-delivered.

**Auth:** API key bearer

**Request**
```
POST /api/server/poll
Authorization: Bearer gvsk_...
Content-Type: application/json
```
```json
{ "server_id": "a0000000-..." }
```

**Response** `200 OK`
```json
{
  "commands": [
    {
      "id": "cmd_abc123",
      "command_type": "start_game",
      "payload": { "game_id": "snes_super_mario_world" }
    }
  ],
  "next_poll_ms": 2000
}
```

`next_poll_ms` guides the poll interval: 2000ms when idle, 250ms when
commands were recently delivered (active session).

**Error responses**
| Status | Cause |
|--------|-------|
| `401 Unauthorized` | Missing or invalid API key |
| `400 Bad Request` | Missing `server_id` |

---

### POST /api/server/notify — Report worker URL (server → web)

Called by gv-server after successfully spawning a gv-worker. Creates or
updates a session record with the worker URL.

**Auth:** API key bearer

**Request**
```
POST /api/server/notify
Authorization: Bearer gvsk_...
Content-Type: application/json
```
```json
{
  "command_id": "cmd_abc123",
  "worker_url": "http://192.168.86.126:54321",
  "game_id": "snes_super_mario_world"
}
```

For `stop_game`:
```json
{
  "command_id": "cmd_def456",
  "worker_url": "",
  "game_id": "snes_super_mario_world",
  "action": "stop"
}
```

**Response** `200 OK`
```json
{ "ok": true }
```

**Error responses**
| Status | Cause |
|--------|-------|
| `401 Unauthorized` | Missing or invalid API key |
| `400 Bad Request` | Missing `command_id` or `game_id` |

---

### GET /api/server/notify — Poll for worker URL (browser → web)

The browser polls this endpoint after submitting a `start_game` command.
Returns the worker URL once the server has reported it.

**Auth:** OAuth session

**Query parameters**
| Param | Required | Description |
|-------|----------|-------------|
| `server_id` | Yes | Server UUID |
| `worker_token` | Yes | Token from command POST response |

**Request**
```
GET /api/server/notify?server_id=a0000000-...&worker_token=tok_def456
```

**Response** `200 OK` (session ready)
```json
{
  "worker_url": "http://192.168.86.126:54321",
  "game_id": "snes_super_mario_world",
  "status": "ready"
}
```

**Response** `200 OK` (not ready yet)
```json
{
  "worker_url": null,
  "status": "waiting"
}
```

**Response** `200 OK` (session ended)
```json
{
  "worker_url": null,
  "status": "stopped"
}
```

**Error responses**
| Status | Cause |
|--------|-------|
| `401 Unauthorized` | No valid session |
| `400 Bad Request` | Missing `server_id` or `worker_token` |

---

### GET /api/servers/members — List user's servers

Returns all servers paired with the current user's account. Used by the
dashboard to show which servers are available for commands.

**Auth:** OAuth session

**Request**
```
GET /api/servers/members
```

**Response** `200 OK`
```json
{
  "servers": [
    {
      "id": "a0000000-...",
      "name": "Vault",
      "created_at": "2026-06-14T00:00:00.000Z"
    }
  ]
}
```

---

### GET /api/auth/[...nextauth] — NextAuth.js handler

Standard NextAuth.js route handler. Handles OAuth sign-in flow, session
management, and CSRF protection. Managed by NextAuth.js — no custom logic.

**Auth:** Handled by NextAuth.js

---

## cURL examples

```bash
# Generate a pairing code (requires session cookie)
curl -X POST http://localhost:3001/api/auth/pair/generate   -H "Cookie: authjs.session-token=..."

# Claim a pairing code
curl -X POST http://localhost:3001/api/auth/pair/claim   -H "Content-Type: application/json"   -d '{"code": "ABCD-EFGH"}'

# Poll for commands (server → web)
curl -X POST http://localhost:3001/api/server/poll   -H "Authorization: Bearer gvsk_..."   -H "Content-Type: application/json"   -d '{"server_id": "a0000000-..."}'

# Queue a start command (browser → web)
curl -X POST http://localhost:3001/api/server/command   -H "Content-Type: application/json"   -H "Cookie: authjs.session-token=..."   -d '{"type":"start_game","server_id":"a0000000-...","payload":{"game_id":"snes_super_mario_world"}}'

# Poll for worker URL (browser → web)
curl "http://localhost:3001/api/server/notify?server_id=a0000000-...&worker_token=tok_def456"   -H "Cookie: authjs.session-token=..."
```
