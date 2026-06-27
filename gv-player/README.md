# gv-player

Browser-side WebRTC client for Games Vault. Vanilla JavaScript, no framework dependency.

The player is served by `gv-web` and connects through the gateway/session relay to `gv-server`. Direct `gv-worker` mode is legacy; `gv-worker` is no longer a separate production binary.

## Current flow

1. Browser opens `/play/<game_id>` or a shared `/p/<code>` link.
2. `gv-web` creates or resolves a session.
3. The browser exchanges SDP through `gv-web`.
4. `gv-server` runs the game in-process and streams WebRTC media/DataChannel input.

## Tests

```bash
pnpm test
```

Integration tests that refer to `GV_WORKER_URL` are legacy/direct-mode tests and should be updated or removed before public release.
