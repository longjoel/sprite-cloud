# Games Vault Protocol

This document defines every contract between the four components.
It is the authoritative reference — code must match this spec.

## Components

```
gv-web      Next.js web app — pairing, auth, command queue, session store
gv-server   Rust binary — polls for commands, manages gv-worker processes
gv-worker   Rust binary — per-game WebRTC peer + VP8 video stream
Browser     Vanilla JS client (gv-player) — connects via WebRTC to gv-worker
```

## Trust Model

```
Browser ── OAuth session ──→ gv-web       (full user auth)
gv-server ── API key ──────→ gv-web       (bearer token from pairing)
gv-server ── control token → gv-worker    (per-worker bearer token)
Browser ── worker_token ──→ gv-web        (lightweight proof of command ownership)
Browser ── WebRTC media ──→ gv-worker     (media/DataChannel after server-relayed SDP)
```

- **gv-web** trusts **gv-server** implicitly after pairing (API key = shared secret)
- **gv-web** trusts **Browser** via OAuth session
- **gv-worker** trusts no unauthenticated HTTP caller. gv-server generates a per-worker
  control token at spawn time and sends it in the HTTP authorization header when
  relaying SDP or requesting shutdown/debug control.
- **worker_token** bridges the browser/gv-web gap: generated at command time, passed
  through browser, validated by gv-web — proves the browser owns the command it is
  polling for.
- **host_token** is session authority for privileged DataChannel commands. gv-worker
  seeds it from `GV_HOST_TOKEN`; SDP offers cannot overwrite an already-set token.
- Binary controller input is not exempt from auth: a peer must authenticate as Host
  before input packets are forwarded to the core.

---

## 1. Server Pairing

```
Browser                     gv-web                          gv-server
  │                           │                                │
  │ GET /dev                  │                                │
  │← pair code: "ABCD-EFGH"   │                                │
  │                           │                                │
  │                           │         POST /api/auth/pair/claim
  │                           │←─────── { code: "ABCD-EFGH" }  │
  │                           │── { api_key, server_id } ──────►│
  │                           │                                │ saves to config.toml
```

### Pair claim

**Request** `POST /api/auth/pair/claim` (server → gv-web)

```json
{ "code": "ABCD-EFGH" }
```

**Response** `200 OK`

```json
{
  "api_key": "gvsk_a1b2c3d4e5f6...",
  "server_id": "a0000000-0000-0000-0000-000000000001"
}
```

### Pairing codes

- 8-letter case-insensitive alphanumeric (Plex-style)
- 5-minute TTL from generation
- One-time use — claimed codes are deleted

---

## 2. Command Lifecycle

Every game session flows through two commands: `start_game` → `stop_game`.

### 2.1 Start Game

```
Browser                    gv-web                        gv-server                gv-worker
  │                          │                              │                        │
  │ POST /api/server/command │                              │                        │
  │ { type: "start_game",    │                              │                        │
  │   payload: {game_id} }   │                              │                        │
  │                          │ generates worker_token       │                        │
  │                          │ inserts into commands table  │                        │
  │← { id, worker_token } ───│                              │                        │
  │                          │                              │                        │
  │                          │     GET /api/server/poll     │                        │
  │                          │←─────────────────────────────│                        │
  │                          │── { commands: [{             │                        │
  │                          │      id, type: "start_game", │                        │
  │                          │      payload: {game_id} }] } │                        │
  │                          │                              │ spawn(port 0)         │
  │                          │                              │──────────────────────►│
  │                          │                              │                    binds port
  │                          │                              │         WORKER_READY port=N
  │                          │                              │←──────────────────────│
  │                          │                              │ GET /health           │
  │                          │                              │──────────────────────►│
  │                          │                              │← 200 OK ──────────────│
  │                          │                              │                        │
  │                          │  POST /api/server/notify     │                        │
  │                          │← { command_id, worker_url,   │                        │
  │                          │    game_id } ────────────────│                        │
  │                          │ creates/updates session      │                        │
  │                          │                              │                        │
  │ POST /api/server/command │                              │                        │
  │ { type: "sdp_offer",     │                              │                        │
  │   payload: {sdp} } ─────►│                              │                        │
  │                          │     GET /api/server/poll     │                        │
  │                          │←─────────────────────────────│                        │
  │                          │── { type: "sdp_offer" } ───►│                        │
  │                          │                              │ POST /sdp              │
  │                          │                              │ auth: worker control  │
  │                          │                              │ token ───────────────►│
  │                          │                              │← { sdp: answer } ─────│
  │                          │← POST /api/server/notify ───│                        │
  │← { sdp_answer } ─────────│                              │                        │
  │←════════════════════════ WebRTC media/DataChannel ════════════════════════════►│
```

#### Command submission

**Request** `POST /api/server/command` (browser → gv-web, OAuth session + CSRF)

```http
x-csrf-token: <same value as gv_csrf_token cookie>
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

**Response** `201 Created`

```json
{
  "id": "cmd_abc123",
  "worker_token": "tok_def456"
}
```

Command creation is a browser-side mutation and must pass double-submit CSRF:
`x-csrf-token` must match the `gv_csrf_token` cookie. gv-server bearer-token
poll/notify flows do not use browser cookies and are not CSRF-gated.

Payloads are schema-validated before insert; command handlers must reject unknown
payload fields instead of treating them as inert. Current accepted payloads:

- `start_game`: `{ "game_id": string, "host_token"?: string }`
- `stop_game`: `{ "game_id": string }`
- `sdp_offer`: `{ "game_id": string, "sdp": string, "host_token"?: string }`
- `browse_files`: `{ "path": string }`
- `scan_paths`: `{ "paths": string[] }`

For `start_game`, gv-web resolves `gameFiles` by both `game_id` and the selected
`server_id`. A server must never receive another server's ROM path.

`worker_token` is a random string generated by gv-web. The browser stores it
and passes it back when polling for the worker URL.

#### Server poll

**Request** `GET /api/server/poll` (gv-server → gv-web, bearer auth)

**Response** `200 OK`

```json
{
  "commands": [
    {
      "id": "cmd_abc123",
      "type": "start_game",
      "payload": { "game_id": "snes_super_mario_world" },
      "lease_token": "lease_abc123",
      "lease_expires_at": "2026-06-17T00:00:30.000Z",
      "attempt": 1
    }
  ],
  "next_poll_ms": 250
}
```

Commands are leased, not consumed. Poll changes eligible rows from `pending` or
expired `leased` to `leased`, sets `leased_at`, `lease_expires_at`, increments
`attempts`, and returns the `lease_token`. A command is only finished after
successful `notify` or `result` completion moves it to `completed`; failed work can
be retried after lease expiry or marked `failed` by a future failure-reporting path.

#### Worker ready contract

gv-server spawns gv-worker with `port 0` (random port). gv-worker writes
a single structured line to **stderr** at startup:

```
WORKER_READY port=54321
```

gv-server reads this line to get the actual port. gv-worker also prints a
human-readable line to stdout (JSON) for log aggregation:

```json
{"timestamp":"...","level":"INFO","fields":{"message":"gv-worker listening on port 54321"},"span":{"service":"gv-worker","name":""}}
```

The `WORKER_READY` line on stderr is the **structured contract** — gv-server
parses it programmatically. The JSON line is for humans.


#### Worker control token

gv-server generates a random per-worker control token for every spawned worker and
passes it via `GV_WORKER_CONTROL_TOKEN`. When that variable is set, gv-worker
requires:

```http
Use the HTTP authorization header for the worker control token.
```

on all worker HTTP control/debug endpoints except `GET /health`:

- `POST /sdp`
- `POST /shutdown`
- `GET /state`
- `GET /test-frame`
- `GET /`

The browser must not receive this token. Browser SDP goes through gv-web/gv-server;
gv-server is the trusted caller that adds the worker control bearer token.

#### ICE policy

Browser and worker share one ICE configuration sourced from environment variables:

| Variable | Description | Default |
|---|---|---|
| `GV_ICE_STUN_URLS` | Comma-separated STUN URLs | `stun:stun.l.google.com:19302` |
| `GV_ICE_TURN_URLS` | Comma-separated TURN URLs | (none) |
| `GV_ICE_TURN_USERNAME` | TURN username | (none) |
| `GV_ICE_TURN_CREDENTIAL` | TURN credential | (none) |
| `GV_ICE_TRANSPORT_POLICY` | `all` or `relay` | `all` |

gv-worker parses these directly at startup. gv-web exposes them to the browser
via `GET /api/ice-config`. Credentials are never logged. When TURN URLs are set
without matching username/credential, a warning is emitted and the TURN server
is used without authentication.


#### Route diagnostics

After a WebRTC connection is established, the player inspects the selected
candidate pair via `RTCPeerConnection.getStats()` and classifies the route:

| Route | Meaning |
|---|---|
| `local` | Host candidates on both sides (LAN) |
| `direct` | Server-reflexive STUN on either side |
| `relay` | TURN relay on either side |
| `failed` | ICE connection failed |
| `unknown` | Connected but stats unavailable |

The player fires an internal `_onRoute(route, detail)` callback. The host UI
shows a small route badge (e.g. "local", "direct", "relay") in the player
overlay. Raw candidate IPs are never displayed in production UI.

The browser player fetches `/api/ice-config` before creating its
`RTCPeerConnection`. When the endpoint is unreachable, the player falls back to
Google's public STUN.


#### Health check

After reading the port, gv-server probes `GET http://worker:port/health`
before notifying gv-web. The endpoint returns `200 OK` when the HTTP server
and WebRTC stack are initialized.

#### Notify

**Request** `POST /api/server/notify` (gv-server → gv-web, bearer auth)

```json
{
  "command_id": "cmd_abc123",
  "lease_token": "lease_abc123",
  "worker_url": "http://192.168.86.126:54321",
  "game_id": "snes_super_mario_world"
}
```

**Response** `200 OK`

```json
{ "ok": true }
```

gv-web first verifies the authenticated bearer-token server owns `command_id`.
Commands are selected by both command id and authenticated `server.id`; cross-server
notify attempts return `404`. Session lookup/update is also scoped to the same
server id before `status`, `worker_url`, or `sdp_answer` are mutated.

When a `lease_token` is supplied, gv-web verifies it matches the active `leased`
command before accepting the notify and marks the command `completed`. When
authorized, gv-web creates or updates a `sessions` row with `status: "ready"` and
propagates the `worker_token` from the command record.

#### Browser poll for worker URL

**Request** `GET /api/server/notify?server_id=X&worker_token=abc123`
(browser → gv-web)

**Response** `200 OK`

```json
{
  "worker_url": "http://192.168.86.126:54321",
  "game_id": "snes_super_mario_world",
  "status": "ready"
}
```

Returns `"worker_url": null` if no session is ready yet. The browser polls
this endpoint until a URL appears, then connects via WebRTC.

### 2.2 Stop Game

```
Browser                    gv-web                        gv-server                gv-worker
  │                          │                              │                        │
  │ POST /api/server/command │                              │                        │
  │ { type: "stop_game",     │                              │                        │
  │   payload: {game_id} }   │                              │                        │
  │← { id } ─────────────────│                              │                        │
  │                          │                              │                        │
  │                          │     GET /api/server/poll     │                        │
  │                          │←─────────────────────────────│                        │
  │                          │── { commands: [{             │                        │
  │                          │      id, type: "stop_game",  │                        │
  │                          │      payload: {game_id} }] } │                        │
  │                          │                              │ POST /shutdown        │
  │                          │                              │ auth: worker control  │
  │                          │                              │ token ───────────────►│
  │                          │                              │                     dies
  │                          │                              │ PID file removed      │
  │                          │                              │                        │
  │                          │  POST /api/server/notify     │                        │
  │                          │← { command_id, game_id,      │                        │
  │                          │    action: "stop" } ─────────│                        │
  │                          │ session.status = "stopped"   │                        │
  │                          │ session.endedAt = now()      │                        │
```

#### Command submission

Same endpoint, different type:

```json
{
  "type": "stop_game",
  "server_id": "a0000000-...",
  "payload": {
    "game_id": "snes_super_mario_world"
  }
}
```

`worker_token` is not generated for stop commands (no session creation).

#### Server handling

gv-server receives the command, removes the worker from its tracking map,
calls `SpawnedWorker::kill()` (SIGTERM → wait → remove PID file), then
notifies gv-web with `action: "stop"`.

If the `game_id` is not found in the worker map (already dead, crashed,
or never started), gv-server logs a warning and ignores the command.

#### Notify stop

**Request** `POST /api/server/notify` (gv-server → gv-web, bearer auth)

```json
{
  "command_id": "cmd_def456",
  "lease_token": "lease_def456",
  "worker_url": "",
  "game_id": "snes_super_mario_world",
  "action": "stop"
}
```

When `action` is `"stop"`, gv-web sets `status: "stopped"` and `endedAt`
on the session record. Existing sessions only — no new session is created.
`worker_url` is ignored for stop actions.

---

## 3. Worker Lifecycle

### Spawn

```rust
// gv-server/src/worker.rs
spawn_worker(game_id, worker_bin_override) -> SpawnedWorker
```

1. Resolve binary path (config → env var → auto-detect release/debug)
2. Spawn `gv-worker 0` (port 0 = random)
3. Write PID file to `/tmp/gv-workers/<game_id>.pid`
4. Read stderr until `WORKER_READY port=N`
5. Health check `GET /health`
6. Return `SpawnedWorker { url, game_id, child }`

### Binary path resolution

1. `config.toml` → `gv_web.worker_bin` (persistent, set during pairing)
2. `GV_WORKER_BIN` env var (override)
3. Auto-detect: `./target/release/gv-worker` → `./target/debug/gv-worker`

### Kill

```rust
SpawnedWorker::kill()
```

1. SIGTERM the child process
2. Wait for exit
3. Remove PID file

### Crash recovery

gv-server writes PID files on spawn and removes them on clean kill. If
gv-server crashes (SIGKILL, OOM, power loss), PID files remain. On next
startup, `reap_stale_workers()` scans `/tmp/gv-workers/` and kills any
processes whose PID files still exist.

---

## 4. Data Model

### Commands table

| Column | Type | Description |
|--------|------|-------------|
| id | uuid | Command ID |
| userId | uuid | Who created it |
| serverId | uuid | Target server |
| type | string | `"start_game"` or `"stop_game"` |
| payload | jsonb | `{game_id: "..."}` |
| status | string | `"pending"` → `"delivered"` |
| workerToken | string? | Random token (start_game only) |
| createdAt | timestamp | |

### Sessions table

| Column | Type | Description |
|--------|------|-------------|
| id | uuid | |
| userId | uuid | |
| serverId | uuid | |
| gameId | string | Game identifier |
| commandId | uuid | FK to commands |
| workerUrl | string? | Connect URL from notify |
| status | string | `"ready"` or `"stopped"` |
| createdAt | timestamp | |
| endedAt | timestamp? | Set on stop |

---

## 5. Error Handling Conventions

### gv-server → gv-worker (spawn)

Failures during spawn (binary not found, port timeout, health check fail)
return an `Err` to the caller. The server logs the error and continues
polling — a failed worker does not crash the server.

### gv-server → gv-web (notify)

Notify retries 3 times with exponential backoff (1s/2s/4s). On final
failure, the server prints the worker URL to the log so the operator
can connect manually.

### Worker connection failure

If the WebRTC peer disconnects or fails:
- gv-worker's streaming loop exits
- The peer connection is closed
- `AppState.peer_connection` is cleared
- gv-worker remains running, ready for a new SDP offer

### Orphaned workers

PID file reaper on startup kills any workers left behind by a previous
crash. The `/tmp/gv-workers/` directory is the single source of truth
for active workers.

### Unknown command types

gv-server ignores command types it doesn't recognize. Adding a new
command type requires no server restart — just deploy the new handler
code.

### TTL cleanup

gv-web runs a periodic cleanup (`lib/db/cleanup.ts`) on startup and
every 60 seconds:

- **Delivered commands** older than 1 hour are deleted
- **Ended sessions** (`endedAt` set, older than 1 hour) are deleted

Cleanup failures are logged, not fatal — the server continues to
function without it.

---

## 6. Environment Variables

See `.env.example` for the full list. Key variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `GV_WORKER_BIN` | auto-detect | gv-worker binary path |
| `GV_WORKER_HOST` | LAN IP | Hostname in worker URL |
| `GV_WEB_TIMEOUT_SECS` | 30 | HTTP timeout for gv-web calls |
| `STUN_SERVER` | stun:stun.l.google.com:19302 | WebRTC NAT traversal |
| `TARGET_BITRATE_KBPS` | 500 | VP8 encoder bitrate |
| `SERVER_API_KEY` | — | Shared secret for server auth (gv-web) |

## 7. Logging

All Rust components output JSON to stdout via `tracing`:

```json
{
  "timestamp": "2026-06-14T00:10:09.929Z",
  "level": "INFO",
  "fields": { "message": "gv-worker listening on port 34127" },
  "span": { "service": "gv-worker", "name": "" }
}
```

- `service` field: `"gv-server"` or `"gv-worker"`
- `level`: `ERROR`, `WARN`, `INFO`, `DEBUG`
- `timestamp`: RFC 3339 with nanoseconds
- Filter with `RUST_LOG=gv_server=debug` for verbose output
