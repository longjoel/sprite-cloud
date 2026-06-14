# Testing Guide

Every test suite in the Games Vault v2 monorepo — how to run them,
what they cover, and what they need.

---

## Test suites

| Suite | Command | Location | Framework |
|-------|---------|----------|-----------|
| gv-server unit | `cargo test -p gv-server` | `gv-server/src/` | Rust `#[test]` |
| gv-worker unit | `cargo test -p gv-worker` | `gv-worker/src/` | Rust `#[test]` |
| gv-worker integration | `cargo test --test integration -p gv-worker` | `gv-worker/tests/` | Rust `#[tokio::test]` |
| gv-web API | `cd gv-web && pnpm test` | `gv-web/__tests__/` | vitest |
| gv-player unit | `cd gv-player && node tests/player.test.js` | `gv-player/tests/` | Node `node:test` |

### Run all Rust tests

```bash
cargo test --workspace
```

### Run all JS tests

```bash
cd gv-web && pnpm test
```

---

## gv-server unit tests

**Covers:** config parsing, retry logic, worker lifecycle (spawn/kill stubs),
poll response parsing, PID file reaper.

**Prerequisites:** Rust toolchain (stable).

```bash
cargo test -p gv-server
```

Run a single test:
```bash
cargo test -p gv-server -- test_name
```

---

## gv-worker unit tests

**Covers:** test pattern generation (bouncing square, color bars), VP8
encoder init and encode, Opus test tone generation, frame size validation.

**Prerequisites:** Rust toolchain + `libvpx` dev headers.

```bash
cargo test -p gv-worker
```

---

## gv-worker integration tests

**Covers:** Spawning a real gv-worker process, HTTP endpoints, SDP
handshake (offer → answer), repeated SDP requests (idempotency),
test frame endpoint, health check endpoint.

**Prerequisites:** gv-worker binary must be built first.

```bash
cargo build -p gv-worker
cargo test --test integration -p gv-worker
```

Run a single integration test:
```bash
cargo test --test integration -p gv-worker -- test_name
```

---

## gv-web API tests

**Covers:** API routes (auth, pairing, commands, notify), database
operations, auth middleware, error responses.

**Prerequisites:** Node.js 22+, pnpm, PostgreSQL running.

```bash
cd gv-web
cp .env.example .env.local   # first time only
pnpm install
pnpm test
```

The test database is separate from dev (`games_vault_test`). vitest
handles setup/teardown via `__tests__/setup.ts`.

### vitest options

```bash
pnpm test -- --reporter=verbose    # detailed output
pnpm test -- --run                 # single run (no watch)
pnpm test -- path/to/test          # run specific file
```

---

## gv-player unit tests

**Covers:** `GvPlayer` class, state machine transitions, SDP exchange
(mocked), DataChannel message handling, cleanup on disconnect.

**Prerequisites:** Node.js 22+.

```bash
cd gv-player
node tests/player.test.js
```

Tests use `linkedom` to simulate a DOM environment — no browser needed.

---

## JS syntax check (pre-commit)

The pre-commit hook runs `node -c` on all staged `.js` files:

```bash
node -c gv-web/public/player/index.js
```

This catches syntax errors but not runtime issues. vitest covers the
runtime behavior.

---

## Benchmark / performance tests

None yet. When the emulator core is integrated, add:

- VP8 encode latency (P50/P99 over 10,000 frames)
- WebRTC connection setup time (offer → first frame)
- DataChannel round-trip latency
- Memory usage under sustained streaming

---

## CI

Jenkins on Vault (`Jenkinsfile` at repo root). Runs `cargo test --workspace`
and `cd gv-web && pnpm test` on every push.

For PR testing, see `references/jenkins-ci-cd.md` in the
`games-vault-development` skill.
