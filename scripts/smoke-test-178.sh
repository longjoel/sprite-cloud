#!/usr/bin/env bash
# Smoke test for #178: start_game path resolution
# Verifies that POST /api/server/command enriches start_game payloads
# with rom_path and platform from the game_files DB lookup.
set -euo pipefail

GV_WEB_URL="${GV_WEB_URL:-http://localhost:3001}"
DB_PORT="${DB_PORT:-5433}"
DB_NAME="${DB_NAME:-gv_web_dev}"
SERVER_ID="a0000000-0000-0000-0000-000000000001"
GAME_ID="e0000000-0000-0000-0000-000000000001"

RED='\033[0;31m'; GREEN='\033[0;32m'; NC='\033[0m'
pass() { echo -e "${GREEN}PASS${NC} $1"; }
fail() { echo -e "${RED}FAIL${NC} $1"; exit 1; }

echo "=== #178 Smoke Test: start_game path resolution ==="

# ── Insert test data ────────────────────────────────────────────────
sudo -u postgres psql -p "$DB_PORT" -d "$DB_NAME" -q <<SQL
INSERT INTO games (id, name, slug, platform) VALUES ('$GAME_ID', '2048 Smoke', '2048-smoke', '2048') ON CONFLICT DO NOTHING;
INSERT INTO game_files (game_id, server_id, rom_path, file_name) VALUES ('$GAME_ID', '$SERVER_ID', '/root/projects/games-vault/test-data/cores/2048_libretro.so', '2048_libretro.so') ON CONFLICT DO NOTHING;
SQL

# ── Sign in ─────────────────────────────────────────────────────────
COOKIE_JAR=$(mktemp /tmp/gv-smoke-cookies.XXXXXX)
CSRF=$(curl -sf -c "$COOKIE_JAR" -b "$COOKIE_JAR" "$GV_WEB_URL/api/auth/signin" \
  | grep -oP 'csrfToken.*?value="([^"]+)"' \
  | grep -oP 'value="([^"]+)"' | head -1 | cut -d'"' -f2)
[ -n "$CSRF" ] || fail "no CSRF token"

curl -sf -c "$COOKIE_JAR" -b "$COOKIE_JAR" \
  -X POST "$GV_WEB_URL/api/auth/callback/lan" \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  -d "username=dev&password=dev&csrfToken=$CSRF&callbackUrl=http%3A%2F%2Flocalhost%3A3001%2F" \
  -o /dev/null

grep -q 'authjs.session-token' "$COOKIE_JAR" || fail "sign in failed"
pass "signed in"

# ── Queue start_game ─────────────────────────────────────────────────
CMD_RESP=$(curl -sf -b "$COOKIE_JAR" \
  -X POST "$GV_WEB_URL/api/server/command" \
  -H 'Content-Type: application/json' \
  -d "{\"server_id\":\"$SERVER_ID\",\"type\":\"start_game\",\"payload\":{\"game_id\":\"$GAME_ID\",\"core_path\":\"test-data/cores/2048_libretro.so\",\"host_token\":\"smoke\"}}")

CMD_ID=$(echo "$CMD_RESP" | grep -oP '"id"\s*:\s*"([^"]+)"' | cut -d'"' -f4)
[ -n "$CMD_ID" ] || fail "no command id in response: $CMD_RESP"
pass "command queued (id=$CMD_ID)"

# ── Verify enriched payload ──────────────────────────────────────────
PAYLOAD=$(sudo -u postgres psql -p "$DB_PORT" -d "$DB_NAME" -q -t -A \
  -c "SELECT payload::text FROM commands WHERE id = '$CMD_ID'")

echo "$PAYLOAD" | grep -q '"rom_path"' || fail "rom_path not in payload"
echo "$PAYLOAD" | grep -q '"platform"' || fail "platform not in payload"
pass "rom_path + platform in payload"

ROM_PATH=$(echo "$PAYLOAD" | grep -oP '"rom_path"\s*:\s*"([^"]+)"' | cut -d'"' -f4)
echo "       rom_path: $ROM_PATH"
PLATFORM=$(echo "$PAYLOAD" | grep -oP '"platform"\s*:\s*"([^"]+)"' | cut -d'"' -f4)
echo "       platform: $PLATFORM"

# ── Cleanup ──────────────────────────────────────────────────────────
sudo -u postgres psql -p "$DB_PORT" -d "$DB_NAME" -q <<SQL
DELETE FROM commands WHERE id = '$CMD_ID';
DELETE FROM game_files WHERE game_id = '$GAME_ID';
DELETE FROM games WHERE id = '$GAME_ID';
SQL
rm -f "$COOKIE_JAR"
echo ""
echo "=== Smoke test passed ==="
