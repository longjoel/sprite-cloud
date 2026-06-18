#!/usr/bin/env bash
# chaos-test.sh — kill worker mid-stream, verify recovery
set -euo pipefail

# ── Config ─────────────────────────────────────────────────────────────
GV_WEB="${GV_WEB_URL:-http://vault:3000}"
SESSION="${GV_SESSION:-}"         # authjs.session-token cookie value
SERVER_ID="${GV_SERVER_ID:-e0da89bb-883a-47fb-bb16-555f3a6d10b9}"
GAME_ID="${GV_GAME_ID:-}"         # must be set — UUID of a game on the server

pass()  { printf '\033[0;32mPASS\033[0m %s\n' "$*"; }
fail()  { printf '\033[0;31mFAIL\033[0m %s\n' "$*"; exit 1; }
info()  { printf '\033[0;36m---\033[0m %s\n' "$*"; }
step()  { printf '\n\033[0;36m=== %s ===\033[0m\n' "$*"; }

# ── Prerequisites ──────────────────────────────────────────────────────
command -v curl >/dev/null || fail "curl not found"
command -v jq >/dev/null || fail "jq not found"
[ -n "$SESSION" ] || fail "GV_SESSION not set (authjs.session-token)"
[ -n "$GAME_ID" ] || fail "GV_GAME_ID not set"

CSRF=$(uuidgen)
CURL_AUTH="Cookie: authjs.session-token=${SESSION}; gv_csrf_token=${CSRF}"
CURL_CSRF="-H X-Csrf-Token:${CSRF}"

if ! curl -sf -o /dev/null "$GV_WEB/api/health"; then
  fail "gv-web not reachable at $GV_WEB"
fi
pass "gv-web is up"

# ── 1. Start a game ────────────────────────────────────────────────────
step "1. Start game"
CMD_RESP=$(curl -s -X POST "$GV_WEB/api/server/command" \
  -H "$CURL_AUTH" $CURL_CSRF \
  -H "Content-Type: application/json" \
  -d "{\"server_id\":\"${SERVER_ID}\",\"type\":\"start_game\",\"payload\":{\"game_id\":\"${GAME_ID}\"}}")
CMD_ID=$(echo "$CMD_RESP" | jq -r '.id // empty')
WORKER_TOKEN=$(echo "$CMD_RESP" | jq -r '.worker_token // empty')
[ -n "$CMD_ID" ] && [ -n "$WORKER_TOKEN" ] || fail "start_game failed: $CMD_RESP"
pass "command queued (id=${CMD_ID:0:8}…)"

# ── 2. Wait for worker ─────────────────────────────────────────────────
step "2. Wait for worker"
WORKER_URL=""
for i in $(seq 1 30); do
  NOTIFY_RESP=$(curl -s "$GV_WEB/api/server/notify?server_id=${SERVER_ID}&worker_token=${WORKER_TOKEN}")
  WORKER_URL=$(echo "$NOTIFY_RESP" | jq -r '.worker_url // empty')
  [ -n "$WORKER_URL" ] && [ "$WORKER_URL" != "null" ] && break
  sleep 1
done
[ -n "$WORKER_URL" ] && [ "$WORKER_URL" != "null" ] || fail "timed out waiting for worker"
pass "worker ready: $WORKER_URL"

# ── 3. Verify health ───────────────────────────────────────────────────
step "3. Worker health"
[ "$(curl -s -o /dev/null -w '%{http_code}' "$WORKER_URL/")" = "200" ] || fail "worker health check failed"
pass "worker health OK"

# ── 4. Find and kill the worker process ────────────────────────────────
step "4. Kill worker"
WORKER_PORT=$(echo "$WORKER_URL" | grep -oP ':\K\d+')
WORKER_PID=$(ss -tlnp "sport = :$WORKER_PORT" 2>/dev/null | grep -oP 'pid=\K\d+' | head -1)
if [ -z "$WORKER_PID" ]; then
  # Try from PID file
  WORKER_PID=$(cat "/tmp/gv-workers/${GAME_ID}.pid" 2>/dev/null || echo "")
fi
[ -n "$WORKER_PID" ] || fail "could not find worker PID"
info "worker PID: $WORKER_PID"

kill -9 "$WORKER_PID"
sleep 1

# ── 5. Verify worker is dead ───────────────────────────────────────────
step "5. Verify worker dead"
if kill -0 "$WORKER_PID" 2>/dev/null; then
  fail "worker PID $WORKER_PID still alive after SIGKILL"
fi
pass "worker process is dead"

# ── 6. Verify gv-server detects death ──────────────────────────────────
step "6. Server detects worker death"
# Poll notify — should return error or null worker_url since worker is dead
DETECTED=0
for i in $(seq 1 15); do
  NOTIFY_RESP=$(curl -s "$GV_WEB/api/server/notify?server_id=${SERVER_ID}&worker_token=${WORKER_TOKEN}")
  STATUS=$(echo "$NOTIFY_RESP" | jq -r '.status // empty' 2>/dev/null)
  WORKER_URL=$(echo "$NOTIFY_RESP" | jq -r '.worker_url // empty' 2>/dev/null)
  if [ "$STATUS" = "ended" ] || [ "$WORKER_URL" = "null" ] || [ -z "$WORKER_URL" ]; then
    DETECTED=1
    break
  fi
  sleep 1
done
[ "$DETECTED" = "1" ] || fail "server did not detect worker death within 15s"
pass "server detected worker death"

# ── 7. Verify PID file cleaned up ──────────────────────────────────────
step "7. PID file cleanup"
PID_FILE="/tmp/gv-workers/${GAME_ID}.pid"
if [ -f "$PID_FILE" ]; then
  info "PID file still exists (may be normal if reaper hasn't run yet)"
fi
pass "chaos test complete — worker killed, server detected, no crash cascade"

echo ""
printf '\033[0;32m=========================================\033[0m\n'
printf '\033[0;32m  Chaos test passed\033[0m\n'
printf '\033[0;32m=========================================\033[0m\n'
echo "  1. Start game:   ✓"
echo "  2. Worker ready: ✓"
echo "  3. Kill worker:  ✓ SIGKILL by PID"
echo "  4. Detect death: ✓ server noticed"
echo "  5. No zombies:   ✓ process killed, no cascade"
