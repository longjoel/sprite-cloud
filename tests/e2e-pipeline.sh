#!/usr/bin/env bash
set -euo pipefail

GV_WEB="${GV_WEB_URL:-http://vault:3000}"
SESSION="${GV_SESSION:-}"     # authjs.session-token cookie value
GAME_ID="${GV_GAME_ID:-}"     # UUID of a known game on the server

pass()  { printf '\033[0;32mPASS\033[0m %s\n' "$*"; }
fail()  { printf '\033[0;31mFAIL\033[0m %s\n' "$*"; exit 1; }
info()  { printf '\033[0;36m---\033[0m %s\n' "$*"; }
step()  { printf '\n\033[0;36m=== %s ===\033[0m\n' "$*"; }

if ! curl -s -o /dev/null -w "%{http_code}" "$GV_WEB/api/health" | grep -q 200; then
  fail "gv-web not reachable"
fi
pass "gv-web is up"

if [ -z "$SESSION" ]; then
  fail "GV_SESSION not set (authjs.session-token)"
fi
pass "auth cookie present"

CSRF=$(uuidgen)
CURL_AUTH=*** authjs.session-token=${SESSION}; gv_csrf_token=${CSRF}"
CURL_CSRF="-H X-Csrf-Token:${CSRF}"

# 1. Pairing
step "1. Pairing"
CODE_RESP=$(curl -s -X POST "$GV_WEB/api/auth/pair/generate" -H "$CURL_AUTH")
PAIR_CODE=$(echo "$CODE_RESP" | jq -r '.code // empty')
[ -n "$PAIR_CODE" ] || fail "generate failed: $CODE_RESP"
pass "code: $PAIR_CODE"

RAW_CODE=$(echo "$PAIR_CODE" | tr -d '-')
CLAIM_RESP=$(curl -s -X POST "$GV_WEB/api/auth/pair/claim" -H "Content-Type: application/json" \
  -d '{"code":"'"'$RAW_CODE"'"}'")
SERVER_ID=$(echo "$CLAIM_RESP" | jq -r '.server_id // empty')
API_KEY=$(echo "$CLAIM_RESP" | jq -r '.api_key // empty')
[ -n "$SERVER_ID" ] && [ -n "$API_KEY" ] || fail "claim failed: $CLAIM_RESP"
pass "claimed — server: ${SERVER_ID:0:8}…"

VERIFY_RESP=$(curl -s "$GV_WEB/api/auth/verify" -H "Authorization: Bearer ${API_KEY}")
VERIFY_ID=$(echo "$VERIFY_RESP" | jq -r '.server_id // empty')
[ "$VERIFY_ID" = "$SERVER_ID" ] || fail "verify failed: $VERIFY_RESP"
pass "API key verified"

# 2. Start game
step "2. Start game"
# Use GAME_ID if provided, otherwise use a test game via the paired server's ROM roots
if [ -n "$GAME_ID" ]; then
  GID="$GAME_ID"
else
  GID="2048-test-$(uuidgen | cut -c1-8)"
fi
CMD_RESP=$(curl -s -X POST "$GV_WEB/api/server/command" \
  -H "$CURL_AUTH" $CURL_CSRF \
  -H "Content-Type: application/json" \
  -d '{"server_id":"'"'$SERVER_ID"'","type":"start_game","payload":{"game_id":"'"'$GID"'"}}')
CMD_ID=$(echo "$CMD_RESP" | jq -r '.id // empty')
WORKER_TOKEN=*** "$CMD_RESP" | jq -r '.worker_token // empty')
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
step "4. SDP relay"
# Worker returns JSON status at /
[ "$(curl -s -o /dev/null -w '%{http_code}' "$WORKER_URL/")" = "200" ] || fail "worker check failed"
pass "worker OK"

SDP_OFFER='v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\na=group:BUNDLE 0 1 2\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\nc=IN IP4 0.0.0.0\r\na=rtpmap:96 VP8/90000\r\na=recvonly\r\na=ice-ufrag:test\r\na=ice-pwd:testtesttesttest\r\na=fingerprint:sha-256 AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89\r\na=setup:actpass\r\na=mid:0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 109\r\nc=IN IP4 0.0.0.0\r\na=rtpmap:109 opus/48000/2\r\na=recvonly\r\na=mid:1\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\nc=IN IP4 0.0.0.0\r\na=sctp-port:5000\r\na=mid:2\r\n'
SDP_RESP=$(curl -s -X POST "$WORKER_URL/sdp" -H "Content-Type: application/json" \
  -d '{"sdp":"'"'$SDP_OFFER'"'"}')
SDP_ANSWER=$(echo "$SDP_RESP" | jq -r '.sdp // empty')
echo "$SDP_ANSWER" | grep -q VP8 || fail "SDP missing VP8"
echo "$SDP_ANSWER" | grep -q sendonly || fail "SDP missing sendonly"
pass "SDP OK (${#SDP_ANSWER} chars)"

# 6. Stop game
step "5. Stop game"
STOP_RESP=$(curl -s -X POST "$GV_WEB/api/server/command" \
  -H "$CURL_AUTH" $CURL_CSRF \
  -H "Content-Type: application/json" \
  -d '{"server_id":"'"'$SERVER_ID"'","type":"stop_game","payload":{"game_id":"'"'$GID"'"}}')
STOP_ID=*** "$STOP_RESP" | jq -r '.id // empty')
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
