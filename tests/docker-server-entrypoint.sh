#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENTRYPOINT="${REPO_ROOT}/docker/sc-server/entrypoint.sh"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT
mkdir -p "$TMP_DIR/bin" "$TMP_DIR/results"

cat >"$TMP_DIR/bin/sc-server" <<'SH'
#!/bin/sh
printf '%s\n' "$*" >>/results/sc-server-calls
SH
cat >"$TMP_DIR/bin/sc-core" <<'SH'
#!/bin/sh
exit 0
SH
cat >"$TMP_DIR/bin/curl" <<'SH'
#!/bin/sh
for arg in "$@"; do
  case "$arg" in
    http://*|https://*) printf '%s\n' "$arg" >>/results/curl-targets ;;
  esac
done
exit 0
SH
cat >"$TMP_DIR/bin/ldd" <<'SH'
#!/bin/sh
exit 0
SH
chmod +x "$TMP_DIR/bin/"*

run_case() {
  local name="$1"
  local web_url="$2"
  local expected_health="$3"
  local result_dir="$TMP_DIR/results/$name"
  mkdir -p "$result_dir"

  local -a env_args=()
  if [[ "$web_url" != "__UNSET__" ]]; then
    env_args=(-e "GV_WEB_URL=$web_url")
  fi

  docker run --rm \
    "${env_args[@]}" \
    -v "$ENTRYPOINT:/entrypoint.sh:ro" \
    -v "$TMP_DIR/bin:/usr/local/bin:ro" \
    -v "$result_dir:/results" \
    alpine:3.22 /bin/sh /entrypoint.sh >/dev/null

  if [[ "$(<"$result_dir/curl-targets")" != "$expected_health" ]]; then
    printf '%s: expected health target %s, got %s\n' \
      "$name" "$expected_health" "$(<"$result_dir/curl-targets")" >&2
    exit 1
  fi
  if ! grep -Fqx 'start' "$result_dir/sc-server-calls"; then
    printf '%s: sc-server start was not invoked\n' "$name" >&2
    exit 1
  fi
}

run_case remote https://gateway.example https://gateway.example/api/health
run_case trailing-slash https://gateway.example/ https://gateway.example/api/health
run_case local-default __UNSET__ http://localhost:3000/api/health

printf 'Docker sc-server gateway probe contract: PASS\n'
