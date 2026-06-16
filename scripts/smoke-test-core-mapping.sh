#!/usr/bin/env bash
# Smoke test: verify core mapping integrity and download capability.
#
# Usage: bash scripts/smoke-test-core-mapping.sh
set -euo pipefail

echo "=== Core mapping smoke test ==="

# 1. Mapping coverage — every scanner-detected platform has a core
echo "--- 1. every_scan_platform_has_core_mapping ---"
cargo test -p gv-server --lib every_scan_platform_has_core_mapping -- --nocapture

# 2. DAT platform coverage — canonical RetroArch names are mapped
echo "--- 2. retroarch_dat_platforms_have_core_mapping ---"
cargo test -p gv-server --lib retroarch_dat_platforms_have_core_mapping -- --nocapture

# 3. First-match ordering — "Game Boy Advance" ≠ "Game Boy"
echo "--- 3. specific_platform_matches_before_broad ---"
cargo test -p gv-server --lib specific_platform_matches_before_broad -- --nocapture

# 4. Download tests
echo "--- 4. core_download_test ---"
cargo test -p gv-server --test core_download_test -- --nocapture

echo ""
echo "=== All smoke tests passed ==="
