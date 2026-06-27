# gv-worker API

`gv-worker` is no longer a separate production process.

The emulator/runtime path has been merged into `gv-server`. Browser signaling now goes through `gv-web` command/result endpoints, and `gv-server` handles WebRTC peer/session work in-process.

See [`PROTOCOL.md`](PROTOCOL.md) for the current protocol.
