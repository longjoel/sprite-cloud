#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

python3 - <<'PY'
from pathlib import Path
import re
import subprocess
import sys

tracked = subprocess.run(
    ["git", "ls-files", "-z"],
    check=True,
    stdout=subprocess.PIPE,
).stdout.split(b"\0")

violations = []
assignment = re.compile(r'^\s*TURN_CREDENTIAL\s*=\s*(["\'])(.*?)\1\s*$')
service_env = re.compile(r'GV_ICE_TURN_CREDENTIAL=([^"\s]+)')

for encoded_path in tracked:
    if not encoded_path:
        continue
    path = Path(encoded_path.decode())
    if path == Path("tests/no-tracked-turn-credentials.sh"):
        continue
    try:
        lines = path.read_text().splitlines()
    except (UnicodeDecodeError, OSError):
        continue

    for line_number, line in enumerate(lines, 1):
        match = assignment.match(line)
        if match and match.group(2) != "${GV_TURN_CREDENTIAL:-}":
            violations.append(f"{path}:{line_number}: TURN_CREDENTIAL has a tracked literal default")

        match = service_env.search(line)
        if match:
            value = match.group(1).strip("\"'")
            placeholders = {"change-me", "replace-me", "example", "placeholder"}
            is_placeholder = value.lower() in placeholders or value.lower().startswith("your")
            if not value.startswith("${") and not is_placeholder:
                violations.append(f"{path}:{line_number}: service TURN credential is a tracked literal")

if violations:
    print("\n".join(violations), file=sys.stderr)
    sys.exit(1)
PY

# Installer diagnostics must not echo an explicitly injected credential.
marker='installer-secret-must-not-be-printed'
output="$(GV_TURN_CREDENTIAL="$marker" bash scripts/install.sh --rootless --print-paths)"
if [[ "$output" == *"$marker"* ]]; then
  printf 'installer diagnostics leaked GV_TURN_CREDENTIAL\n' >&2
  exit 1
fi

printf 'tracked TURN credential contract: PASS\n'
