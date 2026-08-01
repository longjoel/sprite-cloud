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
systemd_environment = re.compile(r'Environment\s*=\s*"([^"]*)"')
allowed = {
    "",
    "${GV_TURN_CREDENTIAL:-}",
    "${GV_ICE_TURN_CREDENTIAL:-}",
    "%s",
    "YOUR_TURN_PASSWORD",
}
scanned_suffixes = {
    ".bash",
    ".conf",
    ".env",
    ".example",
    ".ini",
    ".json",
    ".service",
    ".sh",
    ".socket",
    ".target",
    ".timer",
    ".toml",
    ".yaml",
    ".yml",
}


def should_scan(path: Path) -> bool:
    name = path.name.lower()
    return (
        path == SCRIPT
        or path.suffix.lower() in scanned_suffixes
        or "compose" in name
        or name == "dockerfile"
    )


def unsafe_values(text: str) -> list[str]:
    found = []
    for line in text.splitlines():
        unit_fragments = [
            fragment
            for fragment in systemd_environment.findall(line)
            if "TURN_CREDENTIAL" in fragment
        ]
        targets = unit_fragments or [line]
        for target in targets:
            for match in credential.finditer(target):
                value = next(group for group in match.groups() if group is not None)
                if value not in allowed:
                    found.append(value)
    return found

# Mutations exercise both value parsing and filename selection. Values are
# synthetic and violation output never includes them.
mutation_files = {
    Path("synthetic.sh"): 'TURN_CREDENTIAL="synthetic-literal"',
    Path("synthetic.env"): 'GV_ICE_TURN_CREDENTIAL=synthetic-literal',
    Path("synthetic.yaml"): 'GV_ICE_TURN_CREDENTIAL: "synthetic-literal"',
    Path("synthetic-compose.yml"): 'GV_ICE_TURN_CREDENTIAL="synthetic-literal"',
    Path("synthetic.service"): 'Environment="GV_ICE_TURN_CREDENTIAL=synthetic-literal"',
    Path("synthetic.conf"): 'GV_ICE_TURN_CREDENTIAL=synthetic-literal',
}
if any(
    not should_scan(path) or not unsafe_values(contents)
    for path, contents in mutation_files.items()
):
    print("credential scanner mutation fixture escaped detection", file=sys.stderr)
    sys.exit(1)

near_placeholders = [
    'GV_ICE_TURN_CREDENTIAL="your_turn_password"',
    'GV_ICE_TURN_CREDENTIAL="YOUR_TURN_PASSWORD,"',
    'TURN_CREDENTIAL="${GV_TURN_CREDENTIAL:-synthetic-literal}"',
]
if any(not unsafe_values(fixture) for fixture in near_placeholders):
    print("credential scanner accepted a near-placeholder mutation", file=sys.stderr)
    sys.exit(1)

safe_fixtures = [
    EXPECTED_ASSIGNMENT,
    'GV_ICE_TURN_CREDENTIAL="YOUR_TURN_PASSWORD"',
    'GV_ICE_TURN_CREDENTIAL="${GV_ICE_TURN_CREDENTIAL:-}"',
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
    if path == Path("tests/no-tracked-turn-credentials.sh") or not should_scan(path):
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
  local tmpdir="$TMP_ROOT/$name/tmp"
  local service="$home/.config/systemd/user/sc-server.service"
  local turn_env="$home/.config/sprite-cloud/turn.env"
  local stale_marker="synthetic-stale-marker"
  local output
  mkdir -p "$home" "$roms" "$tmpdir"

  if [[ -z "${credential_value//[[:space:]]/}" ]]; then
    mkdir -p "$(dirname "$turn_env")"
    printf '%s\n' "$stale_marker" > "$turn_env"
    chmod 600 "$turn_env"
  fi

  local -a clean_env=(
    env -i
    HOME="$home"
    LANG=C
    PATH="$MOCK_BIN:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
    TMPDIR="$tmpdir"
  )
  if [[ "$credential_mode" == "unset" ]]; then
    output="$("${clean_env[@]}" bash scripts/install.sh --rootless \
      --web-url https://gateway.invalid --rom-dir "$roms" 2>&1)"
  else
    output="$("${clean_env[@]}" GV_TURN_CREDENTIAL="$credential_value" \
      bash scripts/install.sh --rootless --web-url https://gateway.invalid --rom-dir "$roms" 2>&1)"
  fi

  [[ -f "$service" ]]
  grep -Fq "EnvironmentFile=-$turn_env" "$service"
  ! grep -Fq 'GV_ICE_TURN_CREDENTIAL=' "$service"

  if [[ -z "${credential_value//[[:space:]]/}" ]]; then
    [[ ! -e "$turn_env" ]]
    [[ "$output" == *"relay credential not configured"* ]]
    [[ "$output" != *"$stale_marker"* ]]
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

run_interrupted_cleanup_case() {
  local root="$TMP_ROOT/interrupted"
  local home="$root/home"
  local roms="$root/roms"
  local tmpdir="$root/tmp"
  local mock_bin="$root/mock-bin"
  local marker='synthetic-interrupted-marker'
  mkdir -p "$home" "$roms" "$tmpdir" "$mock_bin"
  ln -s "$MOCK_BIN/curl" "$mock_bin/curl"
  ln -s "$MOCK_BIN/systemctl" "$mock_bin/systemctl"
  cat > "$mock_bin/install" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
destination="${!#}"
if [[ "$destination" == */turn.env ]]; then
  kill -TERM "$PPID"
  exit 143
fi
exec /usr/bin/install "$@"
SH
  chmod 755 "$mock_bin/install"

  local status=0
  env -i HOME="$home" LANG=C \
    PATH="$mock_bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" \
    TMPDIR="$tmpdir" GV_TURN_CREDENTIAL="$marker" \
    bash scripts/install.sh --rootless --web-url https://gateway.invalid --rom-dir "$roms" \
    >/dev/null 2>&1 || status=$?

  [[ "$status" -ne 0 ]]
  ! grep -Rql -- "$marker" "$tmpdir"
  if compgen -G "$tmpdir/*" >/dev/null; then
    printf 'installer interruption left temporary files behind\n' >&2
    return 1
  fi
}

run_installer_case unset unset
run_installer_case empty supplied ""
run_installer_case whitespace supplied "   "
run_installer_case supplied supplied 'synthetic-runtime-"marker"\tail'
run_interrupted_cleanup_case

printf 'tracked TURN credential contract: PASS\n'
