# sc-player

Browser-side WebRTC player assets for Sprite Cloud.

The current player is served by `sc-web` from `sc-web/public/player/`. This package remains in the workspace for compatibility while the player code is consolidated into the gateway app.

Current flow:

1. Browser opens `/play/<game_id>` or a shared `/p/<code>` link on the gateway.
2. `sc-web` creates or resolves the session.
3. SDP is relayed through `sc-web`.
4. `sc-server` runs the emulator/session in-process and streams WebRTC media/DataChannel input.

There is no separate production worker process.
