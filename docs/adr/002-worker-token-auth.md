# ADR 002: Worker token auth for browser ↔ worker binding

**Status:** Accepted  
**Date:** 2026-06-14

## Context

When a browser submits a `start_game` command and gv-server spawns a worker,
the browser needs to connect to that specific worker. The worker URL must be
delivered to the browser, and only the browser that submitted the command
should receive it.

## Decision

gv-web generates a random `worker_token` at command creation time, returns
it to the browser in the command POST response, and the browser passes it
back when polling `GET /api/server/notify?worker_token=...`.

## Rationale

- **No session required for dev flow**: The browser can poll with just the
  token — no OAuth session cookie needed for the notify GET. This enables
  the dev player page (`?worker=`) to work without signing in.
- **Lightweight**: A random string, not a JWT. No expiration logic needed.
- **Binds command to browser**: Only the browser that submitted the command
  knows the token. Prevents other browsers from hijacking the worker URL.
- **Stateless**: gv-web validates the token by looking up the command
  record — no server-side session state needed.

## Consequences

- Tokens are stored in the `commands` table (`workerToken` column).
- Tokens are not cleaned up individually — TTL cleanup deletes delivered
  commands older than 1 hour.
- If a browser loses the token (page refresh), it cannot reconnect —
  the user must submit a new command.
