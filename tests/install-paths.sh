#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INSTALLER="${REPO_ROOT}/scripts/install.sh"
TMP_HOME="$(mktemp -d)"
trap 'rm -rf "$TMP_HOME"' EXIT

assert_line() {
  local output="$1"
  local expected="$2"
  if ! grep -Fqx "$expected" <<<"$output"; then
    printf 'missing expected line: %s\noutput:\n%s\n' "$expected" "$output" >&2
    exit 1
  fi
}

rootless_output="$(HOME="$TMP_HOME" bash "$INSTALLER" --rootless --print-paths)"
assert_line "$rootless_output" "MODE=rootless (user)"
assert_line "$rootless_output" "BIN_DIR=${TMP_HOME}/.local/bin"
assert_line "$rootless_output" "MANAGED_BIN_DIR=${TMP_HOME}/.local/bin"
assert_line "$rootless_output" "BIN_PATH=${TMP_HOME}/.local/bin/sc-server"
assert_line "$rootless_output" "CORE_BIN_PATH=${TMP_HOME}/.local/bin/sc-core"
assert_line "$rootless_output" "DATA_DIR=${TMP_HOME}/.local/share/sprite-cloud"
assert_line "$rootless_output" "CONFIG_DIR=${TMP_HOME}/.config/sprite-cloud"
assert_line "$rootless_output" "SYSTEMD_DIR=${TMP_HOME}/.config/systemd/user"

if [[ "$(id -u)" -eq 0 ]]; then
  system_output="$(bash "$INSTALLER" --print-paths)"
  assert_line "$system_output" "MODE=system-wide (root)"
  assert_line "$system_output" "BIN_DIR=/usr/local/bin"
  assert_line "$system_output" "MANAGED_BIN_DIR=/var/lib/sprite-cloud/bin"
  assert_line "$system_output" "BIN_PATH=/var/lib/sprite-cloud/bin/sc-server"
  assert_line "$system_output" "CORE_BIN_PATH=/var/lib/sprite-cloud/bin/sc-core"
  assert_line "$system_output" "DATA_DIR=/var/lib/sprite-cloud"
  assert_line "$system_output" "CONFIG_DIR=/etc/sprite-cloud"
  assert_line "$system_output" "SYSTEMD_DIR=/etc/systemd/system"
fi

public_output="$(HOME="$TMP_HOME" bash "$REPO_ROOT/sc-web/public/install.sh" --print-paths)"
if [[ "$(id -u)" -eq 0 ]]; then
  assert_line "$public_output" "MODE=system-wide (root)"
  assert_line "$public_output" "INSTALL_DIR=/usr/local/bin"
  assert_line "$public_output" "SC_SERVER_PATH=/usr/local/bin/sc-server"
  assert_line "$public_output" "SC_CORE_PATH=/usr/local/bin/sc-core"
else
  assert_line "$public_output" "MODE=rootless (user)"
  assert_line "$public_output" "INSTALL_DIR=${TMP_HOME}/.local/bin"
  assert_line "$public_output" "SC_SERVER_PATH=${TMP_HOME}/.local/bin/sc-server"
  assert_line "$public_output" "SC_CORE_PATH=${TMP_HOME}/.local/bin/sc-core"
fi

if [[ -e "${TMP_HOME}/.local/bin" || -e "${TMP_HOME}/.config/sprite-cloud" || -e "${TMP_HOME}/.local/share/sprite-cloud" ]]; then
  echo "--print-paths must not create installation directories" >&2
  exit 1
fi

printf 'installer path contract: PASS\n'
