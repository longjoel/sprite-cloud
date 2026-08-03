#!/usr/bin/env bash
# e2e/l1/run-l1.sh — L1 browser-to-emulator E2E (#662 slice 2).
#
# Orchestrates the full journey against a real sc-server in standalone mode:
#   fixture build -> sc-server start -> headless Chrome (H.264) -> Playwright
#   -> WebRTC session -> nestopia -> counter ROM -> assertions -> teardown.
#
# Requirements (CI provides these):
#   - cc65, gcc, python3-pil (fixture build)
#   - node + npm (Playwright)
#   - Google Chrome with H.264 decode (channel 'chrome'; override CHANNEL=)
#   - sc-server + sc-core release binaries (SC_SERVER_DIR)
#   - nestopia_libretro.so (CORE)
#
# Env overrides:
#   SC_SERVER_DIR  dir containing sc-server and sc-core binaries (default: repo target/release)
#   CORE           path to nestopia_libretro.so
#   L1_BASE_URL    where sc-server listens (default http://127.0.0.1:8787)
#   CHANNEL        playwright browser channel (default chrome)
#   KEEP_SERVER    if set, leave sc-server running (debugging)

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
FIXTURE_DIR="$REPO_ROOT/e2e/fixture"
L1_DIR="$REPO_ROOT/e2e/l1"

SC_SERVER_DIR="${SC_SERVER_DIR:-$REPO_ROOT/target/release}"
CORE="${CORE:-}"
BASE_URL="${L1_BASE_URL:-http://127.0.0.1:8787}"
WORK="$(mktemp -d /tmp/l1-XXXXXX)"
ROM_DIR="$WORK/roms"
CORES_DIR="$WORK/cores"
STATE_DIR="$WORK/state"
ARTIFACTS_DIR="$WORK/artifacts"
mkdir -p "$ROM_DIR" "$CORES_DIR" "$STATE_DIR" "$ARTIFACTS_DIR"
trap 'if [ -z "${KEEP_SERVER:-}" ]; then [ -n "${SERVER_PID:-}" ] && kill "$SERVER_PID" 2>/dev/null || true; fi' EXIT

pass() { printf '  \033[0;32mPASS\033[0m %s\n' "$*"; }
fail() { printf '  \033[0;31mFAIL\033[0m %s\n' "$*"; exit 1; }
note() { printf '\033[0;36m[run-l1]\033[0m %s\n' "$*"; }

# ── 0. preflight ───────────────────────────────────────────────────────
command -v node >/dev/null || fail "node not found"
command -v cl65 >/dev/null || fail "cc65 not found (apt-get install cc65)"
[ -x "$SC_SERVER_DIR/sc-server" ] || fail "sc-server not found in $SC_SERVER_DIR (cargo build --release -p sc-server -p sc-core)"
[ -x "$SC_SERVER_DIR/sc-core" ] || fail "sc-core not found in $SC_SERVER_DIR"

PORT="${BASE_URL##*:}"
if curl -fsS --max-time 2 "$BASE_URL/health" >/dev/null 2>&1; then
  fail "something is already serving on $BASE_URL — stop it first (pkill -f 'sc-server start --standalone')"
fi

if [ -z "$CORE" ]; then
  CORE="$CORES_DIR/nestopia_libretro.so"
  note "downloading nestopia core (buildbot)..."
  curl -sL -o "$WORK/nestopia.zip" \
    "https://buildbot.libretro.com/nightly/linux/x86_64/latest/nestopia_libretro.so.zip"
  unzip -o "$WORK/nestopia.zip" -d "$CORES_DIR" >/dev/null
fi
[ -f "$CORE" ] || fail "nestopia core not found at $CORE"

# ── 1. fixture build (deterministic ROM) ───────────────────────────────
note "building fixture..."
"$FIXTURE_DIR/build.sh" >/dev/null
cp "$FIXTURE_DIR/out/rom/counter.nes" "$ROM_DIR/"

# ── 2. sc-server standalone ────────────────────────────────────────────
note "starting sc-server standalone on $BASE_URL ..."
GV_ROM_ROOTS="$ROM_DIR" \
GV_CORES_DIR="$CORES_DIR" \
GV_SYSTEM_DIR="$STATE_DIR" \
GV_CORE_BIN="$SC_SERVER_DIR/sc-core" \
RUST_LOG=warn \
"$SC_SERVER_DIR/sc-server" start --standalone >"$ARTIFACTS_DIR/sc-server.log" 2>&1 &
SERVER_PID=$!

for i in $(seq 1 30); do
  if curl -fsS "$BASE_URL/health" >/dev/null 2>&1; then break; fi
  sleep 1
  [ "$i" = 30 ] && { echo "sc-server failed to start:"; tail -20 "$ARTIFACTS_DIR/sc-server.log"; fail "sc-server not ready"; }
done
note "sc-server up (pid $SERVER_PID)"

# ── 3. sanity: game listed ─────────────────────────────────────────────
GAMES="$(curl -fsS "$BASE_URL/api/games")"
echo "$GAMES" | grep -q '"name":"counter"' || fail "counter game not in library: $GAMES"
note "counter.nes scanned into library"
echo "$GAMES" > "$ARTIFACTS_DIR/games.json"

# ── 4. Playwright ──────────────────────────────────────────────────────
note "installing Playwright deps..."
cd "$L1_DIR"
if [ ! -d node_modules ]; then
  npm install --no-audit --no-fund >/dev/null 2>&1
fi

note "running L1 browser E2E (channel: ${CHANNEL:-chrome})..."
set +e
CHANNEL="${CHANNEL:-chrome}" L1_BASE_URL="$BASE_URL" npx playwright test \
  --output="$ARTIFACTS_DIR/test-results" \
  --reporter=list
PW_RC=$?
set -e

# ── 5. artifacts + result ──────────────────────────────────────────────
cp "$ARTIFACTS_DIR/sc-server.log" "$ARTIFACTS_DIR/sc-server.log" 2>/dev/null || true
# redact bearer capabilities from the server log before it leaves this box
sed -i -E 's/(bearer[=: ]+)[A-Za-z0-9._-]+/\1<redacted>/Ig' "$ARTIFACTS_DIR/sc-server.log"

if [ "$PW_RC" -eq 0 ]; then
  pass "L1 browser E2E passed"
else
  echo "  Playwright exited $PW_RC — artifacts in $ARTIFACTS_DIR"
  exit "$PW_RC"
fi

note "artifacts: $ARTIFACTS_DIR"
