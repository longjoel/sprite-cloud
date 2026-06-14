#!/usr/bin/env bash
set -euo pipefail

GV_WEB="${GV_WEB_URL:-http://localhost:3001}"
COOKIE="${GV_WEB_COOKIE:-}"

pass()  { printf '\033[0;32mPASS\033[0m %s\n' "$*"; }
fail()  { printf '\033[0;31mFAIL\033[0m %s\n' "$*"; exit 1; }
info()  { printf '\033[0;36m---\033[0m %s\n' "$*"; }
step()  { printf '\n\033[0;36m=== %s ===\033[0m\n' "$*"; }

if ! curl -s -o /dev/null -w "%{http_code}" "$GV_WEB/api/health" | grep -q 200; then
  fail "gv-web not reachable"
fi
pass "gv-web is up"

if [ -z "$COOKIE" ]; then
  fail "GV_WEB_COOKIE not set"
fi
pass "auth cookie present"

# 1. Pairing
step "1. Pairing"
CODE_RESP=$(curl -s -X POST "$GV_WEB/api/auth/pair/generate" -H "Cookie: $COOKIE")
PAIR_CODE=$(echo "$CODE_RESP" | jq -r '.code // empty')
[ -n "$PAIR_CODE" ] || fail "generate failed: $CODE_RESP"
pass "code: $PAIR_CODE"

RAW_CODE=$(echo "$PAIR_CODE" | tr -d '-')
CLAIM_RESP=$(curl -s -X POST "$GV_WEB/api/auth/pair/claim" -H "Content-Type: application/json" \
  -d '{"code":"'"'$RAW_CODE'"'"}')
SERVER_ID=$(echo "$CLAIM_RESP" | jq -r '.server_id // empty')
API_KEY=$(echo "$CLAIM_RESP" | jq -r '.api_key // empty')
[ -n "$SERVER_ID" ] && [ -n "$API_KEY" ] || fail "claim failed: $CLAIM_RESP"
pass "claimed — server: ${SERVER_ID:0:8}…"

VERIFY_RESP=$(curl -s "$GV_WEB/api/auth/verify" -H "Authorization: Bearer $API_KEY")
VERIFY_ID=$(echo "$VERIFY_RESP" | jq -r '.server_id // empty')
[ "$VERIFY_ID" = "$SERVER_ID" ] || fail "verify failed: $VERIFY_RESP"
pass "API key verified"

# 2. Start game
step "2. Start game"
CMD_RESP=$(curl -s -X POST "$GV_WEB/api/server/command" -H "Cookie: $COOKIE" \
  -H "Content-Type: application/json" \
  -d '{"server_id":"'"'$SERVER_ID"'","type":"start_game","payload":{"game_id":"smw"}}')
CMD_ID=$(echo "$CMD_RESP" | jq -r '.id // empty')
WORKER_TOKEN=$(echo "$CMD_RESP" | jq -r '.worker_token // empty')
[ -n "$CMD_ID" ] && [ -n "$WORKER_TOKEN" ] || fail "command failed: $CMD_RESP"
pass "command queued"

# 3. Start gv-server
info "Starting gv-server..."
cd "$(dirname "$0")/.."
TMPDIR=$(mktemp -d)
export XDG_CONFIG_HOME="$TMPDIR"
mkdir -p "$TMPDIR/games-vault"

GV_SERVER_BIN="${GV_SERVER_BIN:-./target/debug/gv-server}"
GV_WORKER_BIN="${GV_WORKER_BIN:-./target/debug/gv-worker}"
[ -x "$GV_SERVER_BIN" ] || cargo build --bin gv-server
[ -x "$GV_WORKER_BIN" ] || cargo build --bin gv-worker

cat > "$TMPDIR/games-vault/config.toml" << CFGEOF
[gv_web]
url = "$GV_WEB"
[auth]
api_key = "$API_KEY"
server_id = "$SERVER_ID"
CFGEOF

export GV_WORKER_BIN GV_WORKER_HOST="127.0.0.1"
"$GV_SERVER_BIN" start &
SERVER_PID=$!
trap 'kill $SERVER_PID 2>/dev/null; rm -rf "$TMPDIR"' EXIT

# 4. Wait for worker
step "3. Worker ready"
WORKER_URL=""
for i in $(seq 1 30); do
  NOTIFY_RESP=$(curl -s "$GV_WEB/api/server/notify?server_id=$SERVER_ID&worker_token=$WORKER_TOKEN")
  WORKER_URL=$(echo "$NOTIFY_RESP" | jq -r '.worker_url // empty')
  [ -n "$WORKER_URL" ] && [ "$WORKER_URL" != "null" ] && break
  sleep 1
done
[ -n "$WORKER_URL" ] && [ "$WORKER_URL" != "null" ] || fail "timed out waiting for worker"
pass "worker: $WORKER_URL"

# 5. Health + SDP
[ "$(curl -s -o /dev/null -w '%{http_code}' "$WORKER_URL/health")" = "200" ] || fail "health check failed"
pass "health OK"

step "4. SDP relay"
SDP_OFFER='v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\na=group:BUNDLE 0\r\na=msid-semantic: WMS\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\nc=IN IP4 0.0.0.0\r\na=rtcp:9 IN IP4 0.0.0.0\r\na=ice-ufrag:test\r\na=ice-pwd:testtesttesttest\r\na=fingerprint:sha-256 AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89\r\na=setup:actpass\r\na=mid:0\r\na=recvonly\r\na=rtpmap:96 VP8/90000\r\n'
SDP_RESP=$(curl -s -X POST "$WORKER_URL/sdp" -H "Content-Type: application/json" \
  -d '{"sdp":"'"'$SDP_OFFER'"'"}')
SDP_ANSWER=$(echo "$SDP_RESP" | jq -r '.sdp // empty')
echo "$SDP_ANSWER" | grep -q VP8 || fail "SDP missing VP8"
echo "$SDP_ANSWER" | grep -q sendonly || fail "SDP missing sendonly"
pass "SDP OK (${#SDP_ANSWER} chars)"

# 6. Test frame
[ "$(curl -s "$WORKER_URL/test-frame?frame=0" | wc -c)" = "230400" ] || fail "wrong frame size"
pass "test-frame OK"

# 7. Stop game
step "5. Stop game"
STOP_RESP=$(curl -s -X POST "$GV_WEB/api/server/command" -H "Cookie: $COOKIE" \
  -H "Content-Type: application/json" \
  -d '{"server_id":"'"'$SERVER_ID"'","type":"stop_game","payload":{"game_id":"smw"}}')
STOP_ID=$(echo "$STOP_RESP" | jq -r '.id // empty')
[ -n "$STOP_ID" ] || fail "stop command failed: $STOP_RESP"
pass "stop queued"

info "Waiting for stop to process..."
sleep 3
STOPPED_STATUS=$(curl -s "$GV_WEB/api/server/notify?server_id=$SERVER_ID&worker_token=$WORKER_TOKEN" | jq -r '.status // empty')
[ "$STOPPED_STATUS" = "stopped" ] || fail "session not stopped: $STOPPED_STATUS"
pass "session stopped"

echo ""
printf '\033[0;32m=========================================\033[0m\n'
printf '\033[0;32m  All e2e scenarios passed\033[0m\n'
printf '\033[0;32m=========================================\033[0m\n'
echo "  1. Pairing:   ✓ generate → claim → verify"
echo "  2. Start game: ✓ command → poll → spawn → worker ready"
echo "  3. SDP relay:  ✓ offer → VP8 sendonly answer"
echo "  4. Stop game:  ✓ command → kill → session stopped"
