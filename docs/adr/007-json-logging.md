# ADR 007: JSON structured logging

**Status:** Accepted  
**Date:** 2026-06-14

## Context

All Rust components need logging. Plain-text logs are hard to query and
aggregate in production. The webrtc-rs crate internally emits its own
log lines.

## Decision

All Rust binaries use `tracing` + `tracing-subscriber` with JSON output
to stdout. A `service` field identifies the component (`gv-server` or
`gv-worker`). No `println!` or `eprintln!` for log output.

## Rationale

- **Machine-parseable**: JSON logs can be ingested by Loki, Elasticsearch,
  or `jq` for filtering and aggregation.
- **Uniform format**: Same JSON shape across gv-server, gv-worker, and
  webrtc-rs internals. A single log aggregation pipeline works for all.
- **service field**: Enables filtering (`service=gv-worker`) when
  multiple components log to the same journal.
- **stdout convention**: 12-factor app — logs go to stdout, systemd
  captures them in the journal. No log file management needed.

## Consequences

- Logs are less readable in a raw terminal (JSON is verbose). Use `jq`
  or `journalctl -o json-pretty` for human consumption.
- `WORKER_READY port=N` is the only non-JSON output (on stderr, not
  stdout — see ADR 003).
- Debug-level logs from webrtc-rs internals can be noisy. Filter by
  `RUST_LOG=info` in production.
