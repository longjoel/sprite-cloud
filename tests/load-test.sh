#!/usr/bin/env bash
# load-test.sh — 5 concurrent games without OOM
set -euo pipefail

GV_WEB="${GV_WEB_URL:-http://vault:3000}"
SESSION="${GV_SESSION:-}"
SERVER_ID="${GV_SERVER_ID:-e0da89bb-883a-47fb-bb16-555f3a6d10b9}"
CONCURRENT="${GV_CONCURRENT:-5}"

pass()  { printf '\033[0;32mPASS\033[0m %s\n' "$*"; }
fail()  { printf '\033[0;31mFAIL\033[0m %s\n' "$*"; exit 1; }
info()  { printf '\033[0;36m---\033[0m %s\n' "$*"; }

command -v curl >/dev/null || fail "curl not found"
command -v jq >/dev/null || fail "jq not found"
[ -n "$SESSION" ] || fail "GV_SESSION not set"

CSRF=$(uuidgen)
CURL_AUTH=*** authjs.session-token=${SESSION}; gv_csrf_token=${CSRF}"
CURL_CSRF="-H X-Csrf-Token:${CSRF}"

if ! curl -sf "$GV_WEB/api/health" >/dev/null; then
  fail "gv-web not reachable"
fi
pass "gv-web is up"

# Get initial worker count
INITIAL_WORKERS=$(pgrep -c 'gv-worker' 2>/dev/null || echo 0)
info "initial workers: $INITIAL_WORKERS"

# Start N concurrent games
declare -a PIDS GAME_IDS WORKER_TOKENS

for i in $(seq 1 "$CONCURRENT"); do
  GID="load-$(uuidgen)"
  GAME_IDS+=("$GID")
  
  CMD_RESP=$(curl -s -X POST "$GV_WEB/api/server/command" \
    -H "$CURL_AUTH" $CURL_CSRF \
    -H "Content-Type: application/json" \
    -d "{\"server_id\":\"${SERVER_ID}\",\"type\":\"start_game\",\"payload\":{\"game_id\":\"${GID}\"}}")
  
  TOKEN=*** "$CMD_RESP" | jq -r '.worker_token // empty')
  WORKER_TOKENS+=("$TOKEN")
  
  if [ -n "$TOKEN" ]; then
    info "[$i] started $GID (token=${TOKEN:0:8}…)"
  else
    info "[$i] start failed for $GID: $CMD_RESP"
  fi
done

# Wait for all workers to spawn
info "waiting for workers…"
declare -a WORKER_URLS
for i in $(seq 1 "$CONCURRENT"); do
  TOKEN="${WORKER_TOKENS[$((i-1))]}"
  [ -z "$TOKEN" ] && continue
  
  for attempt in $(seq 1 60); do
    NOTIFY=$(curl -s "$GV_WEB/api/server/notify?server_id=${SERVER_ID}&worker_token=${TOKEN}")
    URL=*** "$NOTIFY" | jq -r '.worker_url // empty')
    if [ -n "$URL" ] && [ "$URL" != "null" ]; then
      WORKER_URLS+=("$URL")
      info "[$i] worker ready: $URL"
      break
    fi
    sleep 1
  done
done

READY_COUNT="${#WORKER_URLS[@]}"
info "workers ready: $READY_COUNT / $CONCURRENT"

# Memory check
MEM=$(free -m | awk '/^Mem:/ {print $3}')
info "memory used: ${MEM}MB"

# Verify all workers healthy
DEAD=0
for url in "${WORKER_URLS[@]}"; do
  if [ "$(curl -s -o /dev/null -w '%{http_code}' "$url/" 2>/dev/null)" != "200" ]; then
    DEAD=$((DEAD + 1))
    info "worker $url is dead/unreachable"
  fi
done

# Stop all games
info "stopping all games…"
for i in $(seq 1 "$CONCURRENT"); do
  GID="${GAME_IDS[$((i-1))]}"
  curl -s -X POST "$GV_WEB/api/server/command" \
    -H "$CURL_AUTH" $CURL_CSRF \
    -H "Content-Type: application/json" \
    -d "{\"server_id\":\"${SERVER_ID}\",\"type\":\"stop_game\",\"payload\":{\"game_id\":\"${GID}\"}}" >/dev/null
done

sleep 3

# Verification
FINAL_WORKERS=$(pgrep -c 'gv-worker' 2>/dev/null || echo 0)
info "final workers: $FINAL_WORKERS"

echo ""
if [ "$DEAD" -eq 0 ] && [ "$READY_COUNT" -ge "$CONCURRENT" ]; then
  printf '\033[0;32m=========================================\033[0m\n'
  printf '\033[0;32m  Load test passed (%d/%d workers)\033[0m\n' "$READY_COUNT" "$CONCURRENT"
  printf '\033[0;32m=========================================\033[0m\n'
else
  printf '\033[0;31m=========================================\033[0m\n'
  printf '\033[0;31m  Load test FAILED (%d/%d ready, %d dead)\033[0m\n' "$READY_COUNT" "$CONCURRENT" "$DEAD"
  printf '\033[0;31m=========================================\033[0m\n'
  exit 1
fi
