#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
RELEASE_DIR="${GV_RELEASE_DIR:-$PROJECT_DIR/.release}"
mkdir -p "$RELEASE_DIR"

GV_SHA="$(git -C "$PROJECT_DIR" rev-parse HEAD)"
GV_SHORT_SHA="${GV_SHA:0:7}"
GV_BRANCH="$(git -C "$PROJECT_DIR" rev-parse --abbrev-ref HEAD)"
GV_BUILT_AT="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"

log()  { printf '[release] %s\n' "$*"; }
warn() { printf '[release][warn] %s\n' "$*" >&2; }
fail() { printf '[release][error] %s\n' "$*" >&2; exit 1; }

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || fail "required command not found: $1"
}

require_clean_tree() {
  if ! git -C "$PROJECT_DIR" diff --quiet || ! git -C "$PROJECT_DIR" diff --cached --quiet; then
    fail "working tree is dirty — commit or clean changes before promoting"
  fi
  if [ -n "$(git -C "$PROJECT_DIR" ls-files -o --exclude-standard)" ]; then
    fail "untracked files present — clean or commit them before promoting"
  fi
}

manifest_path() {
  printf '%s\n' "$RELEASE_DIR/release-manifest.json"
}

checksums_path() {
  printf '%s\n' "$RELEASE_DIR/sha256sums.txt"
}

write_local_manifest() {
  local web_status="$1"
  python3 - <<'PY' "$PROJECT_DIR" "$GV_SHA" "$GV_BRANCH" "$GV_BUILT_AT" "$RELEASE_DIR" "$web_status"
import hashlib, json, os, sys
project_dir, sha, branch, built_at, release_dir, web_status = sys.argv[1:7]

def checksum(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b''):
            h.update(chunk)
    return h.hexdigest()

payload = {
    'git_sha': sha,
    'git_branch': branch,
    'built_at_utc': built_at,
    'web_build': web_status,
    'artifacts': {
        'gv_server': {
            'path': os.path.join(project_dir, 'target/release/gv-server'),
            'sha256': checksum(os.path.join(project_dir, 'target/release/gv-server')),
        },
        'gv_worker': {
            'path': os.path.join(project_dir, 'target/release/gv-worker'),
            'sha256': checksum(os.path.join(project_dir, 'target/release/gv-worker')),
        },
    },
}
with open(os.path.join(release_dir, 'release-manifest.json'), 'w', encoding='utf-8') as f:
    json.dump(payload, f, indent=2)
    f.write('\n')
PY
}

write_remote_release_json() {
  local target_path="$1"
  python3 - <<'PY' "$GV_SHA" "$GV_BRANCH" "$GV_BUILT_AT" "$target_path"
import json, sys
sha, branch, built_at, target_path = sys.argv[1:5]
payload = {
    'git_sha': sha,
    'git_branch': branch,
    'released_at_utc': built_at,
}
with open(target_path, 'w', encoding='utf-8') as f:
    json.dump(payload, f, indent=2)
    f.write('\n')
PY
}
