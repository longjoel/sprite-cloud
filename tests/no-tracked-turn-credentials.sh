#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"
TMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TMP_ROOT"' EXIT

python3 - <<'PY'
from pathlib import Path
import re
import subprocess
import sys

SCRIPT = Path("scripts/install.sh")
EXPECTED_ASSIGNMENT = 'TURN_CREDENTIAL="${GV_TURN_CREDENTIAL:-}"'
if SCRIPT.read_text().splitlines().count(EXPECTED_ASSIGNMENT) != 1:
    print("scripts/install.sh: TURN_CREDENTIAL must use the exact empty-default environment contract", file=sys.stderr)
    sys.exit(1)

credential = re.compile(
    r'(?<![A-Za-z0-9_])(?:TURN_CREDENTIAL|GV_ICE_TURN_CREDENTIAL)'
    r'\s*(?::|=)\s*(?:"([^"]*)"|\'([^\']*)\'|([^\s#]+))'
)
allowed = {
    "",
    "${GV_TURN_CREDENTIAL:-}",
    "%s",
    "change-me",
    "replace-me",
    "placeholder",
    "your-turn-password",
    "your_turn_password",
}
explicit_ice_credential = re.compile(
    r'^\$\{GV_ICE_TURN_CREDENTIAL(?::[-?]([^}]*))?\}$'
)


def is_allowed(value: str) -> bool:
    normalized = value.lower()
    if value in allowed or normalized in allowed:
        return True
    match = explicit_ice_credential.fullmatch(value)
    return bool(match and (match.group(1) or "") in allowed)


def unsafe_values(text: str) -> list[str]:
    found = []
    for match in credential.finditer(text):
        value = next(group for group in match.groups() if group is not None).rstrip('\",')
        if not is_allowed(value):
            found.append(value)
    return found

# Mutation fixtures prove quoted/unquoted shell, YAML, Compose, and systemd
# forms cannot bypass the detector. Values are synthetic and never printed.
mutations = [
    'TURN_CREDENTIAL="synthetic-literal"',
    'GV_ICE_TURN_CREDENTIAL=synthetic-literal',
    'GV_ICE_TURN_CREDENTIAL="synthetic-literal"',
    'GV_ICE_TURN_CREDENTIAL: "synthetic-literal"',
    'Environment="GV_ICE_TURN_CREDENTIAL=synthetic-literal"',
    'TURN_CREDENTIAL="${GV_TURN_CREDENTIAL:-synthetic-literal}"',
]
if any(not unsafe_values(fixture) for fixture in mutations):
    print("credential scanner mutation fixture escaped detection", file=sys.stderr)
    sys.exit(1)

safe_fixtures = [
    EXPECTED_ASSIGNMENT,
    'GV_ICE_TURN_CREDENTIAL="your-turn-password"',
    'write_systemd_environment_value GV_ICE_TURN_CREDENTIAL "$TURN_CREDENTIAL"',
]
if any(unsafe_values(fixture) for fixture in safe_fixtures):
    print("credential scanner rejected a safe fixture", file=sys.stderr)
    sys.exit(1)

tracked = subprocess.run(
    ["git", "ls-files", "-z"],
    check=True,
    stdout=subprocess.PIPE,
).stdout.split(b"\0")
violations = []
for encoded_path in tracked:
    if not encoded_path:
        continue
    path = Path(encoded_path.decode())
    if path == Path("tests/no-tracked-turn-credentials.sh"):
        continue
    if not (
        path == SCRIPT
        or path.suffix.lower() in {".env", ".example", ".toml", ".yaml", ".yml"}
        or "compose" in path.name.lower()
    ):
        continue
    try:
        text = path.read_text()
    except (UnicodeDecodeError, OSError):
        continue
    if unsafe_values(text):
        violations.append(f"{path}: tracked literal TURN credential")

if violations:
    print("\n".join(violations), file=sys.stderr)
    sys.exit(1)
PY

MOCK_BIN="$TMP_ROOT/mock-bin"
mkdir -p "$MOCK_BIN"
cat > "$MOCK_BIN/curl" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
output=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    -o) output="$2"; shift 2 ;;
    -*) shift ;;
    *) shift ;;
  esac
done
[[ -n "$output" ]]
if [[ "$output" == *.sha256 ]]; then
  target="${output%.sha256}"
  digest="$(sha256sum "$target")"
  printf '%s\n' "${digest%% *}" > "$output"
else
  printf '#!/usr/bin/env sh\nexit 0\n' > "$output"
  chmod 755 "$output"
fi
SH
cat > "$MOCK_BIN/systemctl" <<'SH'
#!/usr/bin/env sh
exit 0
SH
chmod 755 "$MOCK_BIN/curl" "$MOCK_BIN/systemctl"

run_installer_case() {
  local name="$1"
  local credential_mode="$2"
  local credential_value="${3-}"
  local home="$TMP_ROOT/$name/home"
  local roms="$TMP_ROOT/$name/roms"
  local output
  mkdir -p "$home" "$roms"

  if [[ "$credential_mode" == "unset" ]]; then
    output="$(env -u GV_TURN_CREDENTIAL HOME="$home" PATH="$MOCK_BIN:$PATH" \
      bash scripts/install.sh --rootless --web-url https://gateway.invalid --rom-dir "$roms" 2>&1)"
  else
    output="$(HOME="$home" PATH="$MOCK_BIN:$PATH" GV_TURN_CREDENTIAL="$credential_value" \
      bash scripts/install.sh --rootless --web-url https://gateway.invalid --rom-dir "$roms" 2>&1)"
  fi

  local service="$home/.config/systemd/user/sc-server.service"
  local turn_env="$home/.config/sprite-cloud/turn.env"
  [[ -f "$service" ]]
  grep -Fq "EnvironmentFile=-$turn_env" "$service"
  ! grep -Fq 'GV_ICE_TURN_CREDENTIAL=' "$service"

  if [[ -z "${credential_value//[[:space:]]/}" ]]; then
    [[ ! -e "$turn_env" ]]
    [[ "$output" == *"relay credential not configured"* ]]
  else
    [[ -f "$turn_env" ]]
    [[ "$(stat -c '%a' "$turn_env")" == "600" ]]
    local escaped_credential="${credential_value//\\/\\\\}"
    escaped_credential="${escaped_credential//\"/\\\"}"
    grep -Fq "GV_ICE_TURN_CREDENTIAL=\"$escaped_credential\"" "$turn_env"
    [[ "$output" != *"$credential_value"* ]]
    ! grep -Fq "$credential_value" "$service"
    [[ "$output" != *"relay credential not configured"* ]]
  fi
}

run_installer_case unset unset
run_installer_case empty supplied ""
run_installer_case whitespace supplied "   "
run_installer_case supplied supplied 'synthetic-runtime-"marker"\tail'

printf 'tracked TURN credential contract: PASS\n'
