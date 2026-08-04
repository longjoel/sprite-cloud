#!/usr/bin/env bash
# L2 gateway-journey E2E (#662 slice 3): full production topology.
#
#   Postgres (docker) → sc-web (next start, :3000) → sc-server paired (:8787)
#     → Playwright walks: gateway login → server → game → WebRTC → nestopia
#
# Environment:
#   GATEWAY_PORT     sc-web port (default 3000)
#   PLAYER_PORT      sc-server player port (default 8787)
#   SC_SERVER_DIR    dir containing sc-server + sc-core binaries (default repo target/release)
#   SC_WEB_DIR       sc-web checkout (default repo sc-web)
#   L2_CHROME_BIN    Chrome binary override (local: /snap/bin/chromium)
#   KEEP_SERVER=1    leave Postgres + sc-web + sc-server running for inspection
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
L2_DIR="$REPO_ROOT/e2e/l2"
FIXTURE_DIR="$REPO_ROOT/e2e/fixture"
SC_WEB_DIR="${SC_WEB_DIR:-$REPO_ROOT/sc-web}"
SC_SERVER_DIR="${SC_SERVER_DIR:-$REPO_ROOT/target/release}"
GATEWAY_PORT="${GATEWAY_PORT:-3000}"
PLAYER_PORT="${PLAYER_PORT:-8787}"
PG_PORT="${PG_PORT:-55432}"
PG_PASSWORD="test-password"

WORK="$(mktemp -d /tmp/l2-XXXXXX)"
CONTAINER=""
GATEWAY_PID=""
SERVER_PID=""

log() { printf '\n\033[1;36m[l2]\033[0m %s\n' "$*"; }
fail() { printf '\n\033[1;31m[l2] FAIL\033[0m %s\n' "$*" >&2; exit 1; }

cleanup() {
  [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null || true
  [ -n "$GATEWAY_PID" ] && kill "$GATEWAY_PID" 2>/dev/null || true
  if [ -n "$CONTAINER" ] && [ -z "${KEEP_SERVER:-}" ]; then
    docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  fi
  [ -z "${KEEP_SERVER:-}" ] && rm -rf "$WORK" || log "artifacts kept: $WORK"
}
trap cleanup EXIT

# ── 0. preflight ───────────────────────────────────────────────────────
command -v node >/dev/null || fail "node not found"
command -v docker >/dev/null || fail "docker not found"
command -v cl65 >/dev/null || fail "cc65 not found (apt-get install cc65)"
[ -x "$SC_SERVER_DIR/sc-server" ] || fail "sc-server not built (SC_SERVER_DIR=$SC_SERVER_DIR)"
[ -x "$SC_SERVER_DIR/sc-core" ] || fail "sc-core not built"

# ── 1. fixture ROM (reused from L1) ────────────────────────────────────
log "Building fixture ROM + core"
"$FIXTURE_DIR/build.sh" >/dev/null
CORE="${CORE:-$HOME/.local/share/sprite-cloud/cores/nestopia_libretro.so}"
if [ ! -f "$CORE" ]; then
  mkdir -p "$(dirname "$CORE")"
  curl -sL -o /tmp/nestopia.zip \
    "https://buildbot.libretro.com/nightly/linux/x86_64/latest/nestopia_libretro.so.zip"
  unzip -o -j /tmp/nestopia.zip -d "$(dirname "$CORE")" >/dev/null
fi
[ -f "$CORE" ] || fail "nestopia core not found: $CORE"

# ── 2. Postgres ────────────────────────────────────────────────────────
# Kill any stale stack from a previous interrupted run — a leftover
# sc-web/sc-server on the same ports silently serves stale state and
# produces baffling failures (e.g. login landing on the marketing page).
# NOTE: the actual process is `next-server`, not `next start` — a pattern
# matching only the npm wrapper misses it entirely.
pkill -f "next-server" 2>/dev/null || true
pkill -f "sc-server start" 2>/dev/null || true
# Remove stale disposable Postgres containers so the new one can bind.
docker ps -q --filter "ancestor=postgres:17-alpine" | xargs -r docker rm -f >/dev/null 2>&1 || true
sleep 1
log "Starting disposable Postgres on :$PG_PORT"
CONTAINER="$(docker run --rm -d -p "$PG_PORT":5432 \
  -e POSTGRES_PASSWORD="$PG_PASSWORD" -e POSTGRES_DB=sc_web_test \
  postgres:17-alpine)"
for i in $(seq 1 30); do
  docker exec "$CONTAINER" pg_isready -U postgres >/dev/null 2>&1 && break
  sleep 1
done
export DATABASE_URL="postgresql://postgres:$PG_PASSWORD@127.0.0.1:$PG_PORT/sc_web_test"

# ── 3. sc-web schema + server ──────────────────────────────────────────
log "Pushing schema to test DB (drizzle-kit)"
(cd "$SC_WEB_DIR" && pnpm exec drizzle-kit push --force >/dev/null 2>&1) \
  || fail "drizzle-kit push failed"

log "Building sc-web (next build)"
(cd "$SC_WEB_DIR" && pnpm build >/dev/null 2>&1) || fail "next build failed"

log "Starting sc-web on :$GATEWAY_PORT"
export AUTH_SECRET="${AUTH_SECRET:-test-secret-l2-e2e}"
# AuthJS v5 rejects untrusted Host headers (UntrustedHost) — `next start`
# runs in production mode where trustHost is NOT auto-enabled (dev-only),
# so it must be set explicitly. (AUTH_TRUST_HOST is the env var; the
# comma-list AUTH_TRUSTED_HOSTS does not exist in this version.)
export AUTH_TRUST_HOST="1"
(cd "$SC_WEB_DIR" && PORT="$GATEWAY_PORT" nohup pnpm start >"$WORK/sc-web.log" 2>&1 & echo $! >"$WORK/gateway.pid")
GATEWAY_PID="$(cat "$WORK/gateway.pid")"
for i in $(seq 1 60); do
  curl -sf "http://127.0.0.1:$GATEWAY_PORT/" >/dev/null 2>&1 && break
  sleep 1
done
curl -sf "http://127.0.0.1:$GATEWAY_PORT/" >/dev/null 2>&1 || fail "sc-web did not come up (see $WORK/sc-web.log)"
# The PID we spawned must still be alive — if it died (EADDRINUSE from a
# stale server), the health check above could have hit the STALE one.
if ! kill -0 "$GATEWAY_PID" 2>/dev/null; then
  fail "sc-web (pid $GATEWAY_PID) died — port $GATEWAY_PORT likely held by a stale server (see $WORK/sc-web.log)"
fi
log "sc-web up (pid $GATEWAY_PID)"

# ── 4. (no pairing — standalone + GV_GATEWAY_URL is the #745 flow) ─────

# ── 5. sc-server (standalone + gateway URL = auth-gated) ──────────────
# NOTE: standalone + GV_GATEWAY_URL is the #745 target flow — direct hits
# get the auth gate, the gateway handles login. (Paired mode proxies `/`
# to sc-web and is covered by unit tests.)
log "Starting sc-server (standalone, gateway-gated) on :$PLAYER_PORT"
export GV_PLAYER_BIND="127.0.0.1:$PLAYER_PORT"
export GV_ROM_ROOTS="$FIXTURE_DIR/rom"
export GV_CORES_DIR="$(dirname "$CORE")"
export GV_SYSTEM_DIR="$WORK/state"
export GV_CORE_BIN="$SC_SERVER_DIR/sc-core"
export GV_GATEWAY_URL="http://127.0.0.1:$GATEWAY_PORT"
mkdir -p "$WORK/state"
nohup "$SC_SERVER_DIR/sc-server" start --standalone >"$WORK/sc-server.log" 2>&1 & echo $! >"$WORK/server.pid"
SERVER_PID="$(cat "$WORK/server.pid")"
for i in $(seq 1 60); do
  curl -sf "http://127.0.0.1:$PLAYER_PORT/health" >/dev/null 2>&1 && break
  sleep 1
done
curl -sf "http://127.0.0.1:$PLAYER_PORT/health" >/dev/null 2>&1 \
  || fail "sc-server did not come up (see $WORK/sc-server.log)"
log "sc-server healthy (gateway-gated)"

# ── 6. Playwright ──────────────────────────────────────────────────────
log "Running Playwright (gateway journey)"
# Self-contained deps: install if absent, so the clean-checkout CI path
# exercises EXACTLY the same code local runs do (no "works on my machine").
# npm install (not ci) mirrors run-l1.sh and tolerates a dirty lockfile.
if [ ! -d "$L2_DIR/node_modules" ]; then
  log "installing L2 harness deps (first run)"
  (cd "$L2_DIR" && npm install --no-audit --no-fund >/dev/null 2>&1)
fi
export GATEWAY_URL="http://127.0.0.1:$GATEWAY_PORT"
export PLAYER_URL="http://127.0.0.1:$PLAYER_PORT"
export GATEWAY_DATABASE_URL="$DATABASE_URL"
export ARTIFACTS_DIR="$WORK/artifacts"
mkdir -p "$ARTIFACTS_DIR"
set +e
(cd "$L2_DIR" && npx playwright test --reporter=list 2>&1 | tee "$WORK/playwright.log")
PW_EXIT=$?
set -e
cp "$WORK/sc-server.log" "$ARTIFACTS_DIR/" 2>/dev/null || true
cp "$WORK/sc-web.log" "$ARTIFACTS_DIR/" 2>/dev/null || true
[ -d "$L2_DIR/test-results" ] && cp -r "$L2_DIR/test-results" "$ARTIFACTS_DIR/" || true

log "artifacts: $WORK/artifacts"
[ "$PW_EXIT" -eq 0 ] || fail "playwright exited $PW_EXIT (see $WORK/playwright.log)"
log "L2 PASS — full gateway journey green"
