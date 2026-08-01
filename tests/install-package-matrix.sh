#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INSTALLER="${REPO_ROOT}/scripts/install.sh"

apt_packages="$(python3 - "$INSTALLER" <<'PY'
import re
import sys
from pathlib import Path

source = Path(sys.argv[1]).read_text()
match = re.search(r'^\s*GST_PKGS="([^"]+)"$', source, re.MULTILINE)
if match is None:
    raise SystemExit("could not find apt GST_PKGS declaration")
print(match.group(1))
PY
)"

if [[ -z "$apt_packages" ]]; then
  echo "apt package declaration must not be empty" >&2
  exit 1
fi

check_image() {
  local image="$1"
  printf 'checking installer packages on %s\n' "$image"
  docker run --rm \
    -e INSTALL_PACKAGES="$apt_packages curl ca-certificates" \
    "$image" \
    sh -ec 'apt-get update -qq && apt-get install -s -qq --no-install-recommends $INSTALL_PACKAGES >/dev/null'
}

check_image ubuntu:22.04
check_image ubuntu:24.04
check_image debian:12-slim

printf 'installer package matrix: PASS\n'
