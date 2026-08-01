#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
QUICKSTART="${REPO_ROOT}/QUICKSTART.md"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

python3 - "$QUICKSTART" "$TMP_DIR" <<'PY'
import re
import sys
from pathlib import Path

quickstart = Path(sys.argv[1]).read_text()
out = Path(sys.argv[2])

def fenced_after(marker: str, language: str) -> str:
    try:
        section = quickstart[quickstart.index(marker) + len(marker):]
    except ValueError as exc:
        raise SystemExit(f"missing quickstart marker: {marker}") from exc
    match = re.search(rf"```{language}\n(.*?)\n```", section, re.DOTALL)
    if match is None:
        raise SystemExit(f"missing {language} block after: {marker}")
    return match.group(1)

compose = fenced_after("Create a `docker-compose.yml` in the same deploy directory:", "yaml")
if "$(" in compose:
    raise SystemExit("Compose YAML must not contain shell command substitution")
if "AUTH_SECRET: ${AUTH_SECRET:?" not in compose:
    raise SystemExit("AUTH_SECRET must be required from the generated .env file")
if "POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:?" not in compose:
    raise SystemExit("Postgres must require POSTGRES_PASSWORD from .env")
if not re.search(r"DATABASE_URL: ['\"]?postgresql://sprite_cloud:\$\{POSTGRES_PASSWORD:\?[^}]+\}@postgres:5432/sprite_cloud", compose):
    raise SystemExit("DATABASE_URL must use the same required POSTGRES_PASSWORD variable")

(out / "docker-compose.yml").write_text(compose + "\n")
env_script = fenced_after("Generate a protected `.env` file before starting Compose:", "bash")
(out / "generate-env.sh").write_text(env_script + "\n")
PY

mkdir "$TMP_DIR/deploy"
cp "$TMP_DIR/generate-env.sh" "$TMP_DIR/deploy/generate-env.sh"
(
  cd "$TMP_DIR/deploy"
  bash generate-env.sh
)

env_file="$TMP_DIR/deploy/.env"
if [[ ! -f "$env_file" ]]; then
  echo "documented secret-generation workflow did not create .env" >&2
  exit 1
fi
if [[ "$(stat -c '%a' "$env_file")" != "600" ]]; then
  echo "generated .env must have mode 600" >&2
  exit 1
fi

set -a
# shellcheck disable=SC1090
source "$env_file"
set +a
if [[ ! "${POSTGRES_PASSWORD:-}" =~ ^[0-9a-f]{64}$ ]]; then
  echo "POSTGRES_PASSWORD must be a generated 32-byte hex value" >&2
  exit 1
fi
if [[ ! "${AUTH_SECRET:-}" =~ ^[0-9a-f]{64}$ ]]; then
  echo "AUTH_SECRET must be a generated 32-byte hex value" >&2
  exit 1
fi
if [[ "$POSTGRES_PASSWORD" == "$AUTH_SECRET" ]]; then
  echo "database and authentication secrets must be independently generated" >&2
  exit 1
fi
if [[ "${AUTH_URL:-}" != "https://your-domain.com" ]]; then
  echo "documented AUTH_URL placeholder is missing" >&2
  exit 1
fi

mkdir "$TMP_DIR/existing"
printf 'DO_NOT_REPLACE=1\n' >"$TMP_DIR/existing/.env"
cp "$TMP_DIR/generate-env.sh" "$TMP_DIR/existing/generate-env.sh"
if (cd "$TMP_DIR/existing" && bash generate-env.sh >/dev/null 2>&1); then
  echo "secret-generation workflow must refuse to overwrite an existing .env" >&2
  exit 1
fi
if [[ "$(<"$TMP_DIR/existing/.env")" != "DO_NOT_REPLACE=1" ]]; then
  echo "existing .env was modified" >&2
  exit 1
fi

cp "$env_file" "$TMP_DIR/.env"
docker compose --project-directory "$TMP_DIR" config >"$TMP_DIR/rendered.yml"
python3 - "$TMP_DIR/rendered.yml" "$POSTGRES_PASSWORD" "$AUTH_SECRET" <<'PY'
import sys
from pathlib import Path
import yaml

rendered = yaml.safe_load(Path(sys.argv[1]).read_text())
password = sys.argv[2]
auth_secret = sys.argv[3]
postgres_env = rendered["services"]["postgres"]["environment"]
web_env = rendered["services"]["sc-web"]["environment"]
assert postgres_env["POSTGRES_PASSWORD"] == password
assert web_env["AUTH_SECRET"] == auth_secret
assert web_env["DATABASE_URL"] == f"postgresql://sprite_cloud:{password}@postgres:5432/sprite_cloud"
PY

printf 'quickstart Compose contract: PASS\n'
