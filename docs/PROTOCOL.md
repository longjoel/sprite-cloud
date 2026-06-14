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
gv-server ── spawn/kill ──→ gv-worker     (process parent, no API auth)
Browser ── worker_token ──→ gv-web        (lightweight proof of command ownership)
Browser ── WebRTC ────────→ gv-worker     (P2P, no auth beyond SDP handshake)
```

- **gv-web** trusts **gv-server** implicitly after pairing (API key = shared secret)
- **gv-web** trusts **Browser** via OAuth session
- **gv-worker** trusts no one — only its parent process (gv-server) can spawn it
- **worker_token** bridges the gap: generated at command time, passed through browser,
  validated by gv-web — proves the browser owns the command it's polling for

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
  │ GET /api/server/notify   │                              │                        │
  │  ?server_id=X            │                              │                        │
  │  &worker_token=abc123 ──►│                              │                        │
  │← { worker_url } ─────────│                              │                        │
  │                          │                              │                        │
  │──── WebRTC SDP ───────────────────────────────────────────────────────────────►│
  │←─── VP8 video stream ──────────────────────────────────────────────────────────│
```

#### Command submission

**Request** `POST /api/server/command` (browser → gv-web, OAuth session)

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

`worker_token` is a random string generated by gv-web. The browser stores it
and passes it back when polling for the worker URL.

#### Server poll

**Request** `POST /api/server/poll` (gv-server → gv-web, bearer auth)

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

Commands are delivered once via a cursor — a consumed command is never re-delivered.

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

#### Health check

After reading the port, gv-server probes `GET http://worker:port/health`
before notifying gv-web. The endpoint returns `200 OK` when the HTTP server
and WebRTC stack are initialized.

#### Notify

**Request** `POST /api/server/notify` (gv-server → gv-web, bearer auth)

```json
{
  "command_id": "cmd_abc123",
  "worker_url": "http://192.168.86.126:54321",
  "game_id": "snes_super_mario_world"
}
```

**Response** `200 OK`

```json
{ "ok": true }
```

gv-web creates or updates a `sessions` row with `status: "ready"` and
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
  │                          │                              │ kill()                │
  │                          │                              │──────────────────────►│
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
