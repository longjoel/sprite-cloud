#!/usr/bin/env bash
set -euo pipefail

ENV_FILE="${GV_WEB_ENV_FILE:-/root/sprite-cloud/.env}"
CONTAINER="${GV_WEB_CONTAINER:-sc-web-sc-web-1}"
IMAGE="${GV_WEB_IMAGE:-sc-web-prod:latest}"
POSTGRES_CONTAINER="${GV_WEB_POSTGRES_CONTAINER:-sc-web-postgres-1}"
PUBLIC_ORIGIN="${GV_WEB_PUBLIC_ORIGIN:-https://sprite-cloud.com}"

log() { printf '[deploy-sc-web] %s\n' "$*"; }
fail() { printf '[deploy-sc-web][error] %s\n' "$*" >&2; exit 1; }

command -v docker >/dev/null 2>&1 || fail 'docker is required'
command -v python3 >/dev/null 2>&1 || fail 'python3 is required'

[ -f "$ENV_FILE" ] || fail "missing env file: $ENV_FILE"

auth_url="$(python3 - <<'PY' "$ENV_FILE" "$PUBLIC_ORIGIN"
from pathlib import Path
import sys
path = Path(sys.argv[1])
public_origin = sys.argv[2]
vals = {}
for line in path.read_text().splitlines():
    if not line or line.lstrip().startswith('#') or '=' not in line:
        continue
    k, v = line.split('=', 1)
    vals[k] = v
candidate = vals.get('AUTH_URL') or vals.get('NEXTAUTH_URL') or vals.get('APP_BASE_URL') or ''
if candidate.startswith(('http://vault:', 'http://localhost:', 'http://127.0.0.1:', 'http://srv', 'http://172.', 'http://192.168.')):
    candidate = public_origin
print(candidate or public_origin)
PY
)"

[ -n "$auth_url" ] || fail "env file must define AUTH_URL, NEXTAUTH_URL, or APP_BASE_URL"

db_url="$(python3 - <<'PY' "$POSTGRES_CONTAINER"
import json, subprocess, sys
container = sys.argv[1]
raw = subprocess.check_output(['docker', 'inspect', container], text=True)
env = json.loads(raw)[0]['Config']['Env']
vals = {}
for item in env:
    if '=' not in item:
        continue
    k, v = item.split('=', 1)
    vals[k] = v
user = vals.get('POSTGRES_USER') or 'sprite_cloud'
password = vals.get('POSTGRES_PASSWORD')
db = vals.get('POSTGRES_DB') or user
if not password:
    raise SystemExit('missing POSTGRES_PASSWORD on ' + container)
print(f'postgresql://{user}:{password}@127.0.0.1:5432/{db}')
PY
)"

log "using auth origin: $auth_url"
log "using db from $POSTGRES_CONTAINER"

python3 - <<'PY' "$ENV_FILE" "$db_url" "$auth_url"
from pathlib import Path
import sys
path = Path(sys.argv[1])
db_url = sys.argv[2]
auth_url = sys.argv[3]
lines = path.read_text().splitlines()
out = []
updated = False
wanted = {
    'DATABASE_URL': db_url,
    'AUTH_URL': auth_url,
    'NEXTAUTH_URL': auth_url,
    'APP_BASE_URL': auth_url,
    'NEXT_PUBLIC_APP_URL': auth_url,
}
seen = set()
for line in lines:
    if '=' not in line or line.lstrip().startswith('#'):
        out.append(line)
        continue
    key, _ = line.split('=', 1)
    if key in wanted:
        if line != f'{key}={wanted[key]}':
            updated = True
        out.append(f'{key}={wanted[key]}')
        seen.add(key)
    else:
        out.append(line)
for key, value in wanted.items():
    if key not in seen:
        out.append(f'{key}={value}')
        updated = True
path.write_text('\n'.join(out) + '\n')
print('updated env file' if updated else 'env already correct')
PY

docker rm -f "$CONTAINER" 2>/dev/null || true
docker run -d --name "$CONTAINER" \
  --network host \
  --restart unless-stopped \
  --env-file "$ENV_FILE" \
  -e DATABASE_URL="$db_url" \
  -e AUTH_URL="$auth_url" \
  -e NEXTAUTH_URL="$auth_url" \
  -e APP_BASE_URL="$auth_url" \
  -e NEXT_PUBLIC_APP_URL="$auth_url" \
  -e NODE_ENV=production \
  -e PORT=3000 \
  -e HOSTNAME=0.0.0.0 \
  "$IMAGE"

for _ in 1 2 3 4 5 6 7 8 9 10; do
  if curl -fsS http://127.0.0.1:3000/api/health >/dev/null 2>&1; then
    break
  fi
  sleep 2
done

curl -fsS http://127.0.0.1:3000/api/health
