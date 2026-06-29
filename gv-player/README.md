# gv-player

Browser-side WebRTC player assets for Sprite Cloud.

The current player is served by `gv-web` from `gv-web/public/player/`. This package remains in the workspace for compatibility while the player code is consolidated into the gateway app.

Current flow:

1. Browser opens `/play/<game_id>` or a shared `/p/<code>` link on the gateway.
2. `gv-web` creates or resolves the session.
3. SDP is relayed through `gv-web`.
4. `gv-server` runs the emulator/session in-process and streams WebRTC media/DataChannel input.

There is no separate production worker process.
