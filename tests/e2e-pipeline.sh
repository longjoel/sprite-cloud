#!/usr/bin/env bash
set -euo pipefail

# Lightweight smoke check for a configured gateway.

GV_WEB="${GV_WEB_URL:-http://localhost:3000}"

pass() { printf '\033[0;32mPASS\033[0m %s\n' "$*"; }
fail() { printf '\033[0;31mFAIL\033[0m %s\n' "$*"; exit 1; }

command -v curl >/dev/null || fail "curl not found"

if ! curl -fsS "$GV_WEB/api/health" >/dev/null; then
  fail "sc-web not reachable at $GV_WEB"
fi
pass "sc-web health OK: $GV_WEB/api/health"

ICE_JSON="$(curl -fsS "$GV_WEB/api/ice-config")"
printf '%s\n' "$ICE_JSON" | grep -q 'iceServers' || fail "ice config missing iceServers"
pass "ice config OK"

pass "gateway smoke checks complete"
