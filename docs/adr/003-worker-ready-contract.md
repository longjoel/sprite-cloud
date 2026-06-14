# ADR 003: WORKER_READY contract on stderr

**Status:** Accepted  
**Date:** 2026-06-14

## Context

gv-server spawns gv-worker with `port 0` (random port) and needs to know
the actual port before it can health-check the worker and notify gv-web.
gv-worker also emits JSON log lines to stdout.

## Decision

gv-worker writes a single structured line to **stderr** at startup:
`WORKER_READY port=N`. gv-server reads stderr, parses this line, and
extracts the port.

## Rationale

- **Channel separation**: stdout carries JSON log lines for aggregation.
  Mixing a structured machine-readable line into stdout would require
  every log consumer (journald, JSON parsers) to filter it out.
- **stderr is for control**: The `WORKER_READY` line is a signal to the
  parent process, not a log entry. stderr is the correct channel for
  process-to-parent communication.
- **Simple parsing**: A single regex match (`WORKER_READY port=(\d+)`)
  on the stderr stream. No JSON parsing, no framing protocol.
- **Human-readable**: If a human runs `gv-worker 0` directly, they see
  the port on the terminal (stderr) alongside the JSON log on stdout.

## Consequences

- gv-server must read both stdout and stderr of its child process.
- The contract is fixed: any change to the format requires a coordinated
  update of gv-server's parser.
- JSON log aggregation tools never see the `WORKER_READY` line (it's on
  stderr, not stdout).
