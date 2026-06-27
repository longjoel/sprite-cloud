# Architecture

Games Vault is a self-hosted game library and browser streaming stack. The current architecture has three runtime roles and no separate worker binary.

## Runtime roles

| Role | Process | Runs where | Responsibility |
|---|---|---|---|
| Gateway | `gv-web` | Server/VPS/container host | Web UI, setup wizard, auth, library metadata, pairing, command relay, session records, ICE config |
| Host runtime | `gv-server` | Linux machine with ROMs/cores | Pairs with the gateway, scans ROM roots, polls for commands, runs libretro cores in-process, owns WebRTC media/DataChannel sessions |
| Player | Browser | Any player device | Opens the gateway, requests play/share sessions, exchanges SDP via the gateway, receives WebRTC audio/video and sends input |

```text
Browser player
  │
  │ HTTPS: UI, auth, session commands, SDP relay
  ▼
gv-web gateway ───────────── PostgreSQL
  ▲
  │ HTTPS polling/API-key auth
  ▼
gv-server host runtime
  │
  ├─ ROM roots
  ├─ libretro core cache
  ├─ GStreamer encoder pipeline
  └─ WebRTC PeerConnections
```

## First-run setup

1. `gv-web` starts with an empty `users` table.
2. The production entrypoint prints a one-time setup code to logs.
3. The admin visits `/setup`, enters the code, and creates the first account.
4. Normal sign-in uses DB-backed email/password credentials.

There is no public LAN username/password bootstrap path.

## Pairing a host

1. An authenticated admin generates a pairing code in the dashboard.
2. The host runs:

   ```bash
   gv-server pair ABCD-EFGH --gv-web-url https://your-gateway.example
   ```

3. `gv-web` exchanges the short-lived code for a server ID and API key.
4. `gv-server` stores those credentials in its config file.
5. From then on, the host authenticates to gateway APIs with `Authorization: Bearer <api key>`.

## Command flow

`gv-server` uses outbound polling so a host can run behind NAT without inbound gateway access.

```text
Browser/admin            gv-web gateway             gv-server host
     │                         │                          │
     │ start game / scan       │                          │
     ├────────────────────────▶│                          │
     │                         │ command queued           │
     │                         │◀─────────────────────────┤ poll
     │                         │                          │
     │                         │ result / session update  │
     │                         │◀─────────────────────────┤
     │ session ready / answer  │                          │
     │◀────────────────────────┤                          │
```

Command types include starting/stopping games, scanning ROM paths, browsing configured roots, and exchanging SDP for player sessions.

## Play/session flow

1. The browser asks `gv-web` to start or join a game.
2. `gv-web` validates the user/session and queues a command for the selected host.
3. `gv-server` resolves the ROM, ensures the libretro core is available, starts the in-process emulator/session, and creates WebRTC state.
4. SDP offer/answer data is relayed through `gv-web`.
5. Media and input flow over WebRTC between the browser and host runtime.
6. Session status/results are reported back to `gv-web` for the dashboard and player UI.

## Data and state

| Data | Owner |
|---|---|
| Users, server registrations, games metadata, queued commands, sessions | `gv-web` Postgres database |
| API key/server ID | `gv-server` config file |
| ROM files | Host filesystem configured via ROM roots |
| Libretro cores | Host core cache |
| Save/state files | Host save directory |
| WebRTC runtime state | In-memory inside `gv-server` |

## Network model

| Path | Protocol | Notes |
|---|---|---|
| Browser → gateway | HTTPS | UI, auth, API routes, SDP relay |
| Host → gateway | HTTPS | API-key authenticated polling and result submission |
| Browser ↔ host | WebRTC | Media and DataChannel; ICE config comes from `/api/ice-config` |
| Gateway → Postgres | PostgreSQL | Private network only |

TURN is optional for LAN/local testing but recommended for public internet play.

## Naming note

Some compatibility names still use `worker` in API fields or env vars, such as `worker_token`, `GV_WORKER_HOST`, and `GV_WORKER_PORT`. In the current architecture these refer to the browser-facing host runtime/session endpoint, not to a separate process.
