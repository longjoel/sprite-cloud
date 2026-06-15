#!/bin/bash
# smoke-test-193.sh — Prove scan → import → library shows games
set -euo pipefail

BASE="http://192.168.86.126:3001"
PSQL="psql postgresql://postgres:postgres@localhost:5433/gv_web_dev -At -c"
COOKIE=$(mktemp)

cleanup() { rm -f "$COOKIE"; }
trap cleanup EXIT

fail() { echo "FAIL: $*"; exit 1; }

# 1. Sign in
echo "=== Sign in ==="
CSRF=$(curl -s -c "$COOKIE" "$BASE/api/auth/csrf" | grep -o '"csrfToken":"[^"]*"' | cut -d'"' -f4)
curl -s -c "$COOKIE" -b "$COOKIE" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "csrfToken=$CSRF&username=dev&password=dev" \
  "$BASE/api/auth/callback/credentials" > /dev/null

# 2. Get server list to find a server with rom_roots
echo "=== Get server with ROM roots ==="
SERVER_ID=$(curl -s -b "$COOKIE" "$BASE/api/servers/members" | \
  python3 -c "
import sys, json
servers = json.load(sys.stdin)
for s in servers:
    if s.get('rom_roots') and len(s['rom_roots']) > 0:
        print(s['id'])
        sys.exit(0)
print('', end='')
")
[ -n "$SERVER_ID" ] || fail "No server with ROM roots found"

echo "Server: $SERVER_ID"

# 3. Enqueue a scan_paths command
echo "=== Enqueue scan ==="
ROM_ROOT=$(curl -s -b "$COOKIE" "$BASE/api/servers/$SERVER_ID/rom-roots" | python3 -c "import sys,json; print(json.load(sys.stdin)[0]['path'])")
CMD_ID=$(curl -s -b "$COOKIE" \
  -H "Content-Type: application/json" \
  -d "{\"server_id\":\"$SERVER_ID\",\"type\":\"scan_paths\",\"payload\":{\"paths\":[\"$ROM_ROOT\"]}}" \
  "$BASE/api/server/command" | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])")
echo "Command: $CMD_ID"

# 4. Poll for the result (up to 30s)
echo "=== Poll result ==="
for i in $(seq 1 30); do
  RESULT=$(curl -s -b "$COOKIE" "$BASE/api/commands/$CMD_ID/result")
  if echo "$RESULT" | python3 -c "
import sys, json
data = json.load(sys.stdin)
if data.get('result') is not None:
    sys.exit(0)
else:
    sys.exit(1)
" 2>/dev/null; then
    echo "Got result after ${i}s"
    break
  fi
  sleep 1
done

# 5. Extract scan matches and call import
echo "=== Import to library ==="
SCAN_RESULT=$(curl -s -b "$COOKIE" "$BASE/api/commands/$CMD_ID/result" | python3 -c "import sys,json; print(json.dumps(json.load(sys.stdin)['result']))")
echo "Scan result: $(echo "$SCAN_RESULT" | python3 -c "import sys,json; r=json.load(sys.stdin); print(f'{len(r.get(\"matches\",[]))} matches')")"

# Build import payload from scan matches
IMPORT_PAYLOAD=$(echo "$SCAN_RESULT" | python3 -c "
import sys, json
result = json.load(sys.stdin)
files = []
for m in result.get('matches', []):
    files.append({
        'name': m.get('match', {}).get('name') or m['file']['file_name'],
        'platform': m['file'].get('platform') or 'Unknown',
        'rom_path': m['file']['relative_path'],
        'file_name': m['file']['file_name'],
        'file_size': m['file'].get('file_size', 0),
    })
print(json.dumps({'server_id': '$SERVER_ID', 'files': files}))
")

IMPORT_RESP=$(curl -s -b "$COOKIE" \
  -H "Content-Type: application/json" \
  -d "$IMPORT_PAYLOAD" \
  "$BASE/api/library/import")
echo "Import: $IMPORT_RESP"

# 6. Verify games appear in library (via DB)
echo "=== Verify library ==="
DB_GAMES=$($PSQL "SELECT id, name, platform FROM games;")
echo "games table:"
echo "$DB_GAMES"
DB_COUNT=$(echo "$DB_GAMES" | grep -c . || echo 0)
[ "$DB_COUNT" -gt 0 ] || fail "games table empty"

DB_FILES=$($PSQL "SELECT game_id, rom_path, file_name FROM game_files;")
echo "game_files table:"
echo "$DB_FILES"
DB_FILES_COUNT=$(echo "$DB_FILES" | grep -c . || echo 0)
[ "$DB_FILES_COUNT" -gt 0 ] || fail "game_files table empty"
echo "PASS: $DB_COUNT games, $DB_FILES_COUNT files in library"
