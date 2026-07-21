#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=scripts/release-common.sh
source "$SCRIPT_DIR/release-common.sh"

require_cmd cargo
require_cmd pnpm
require_cmd sha256sum

log "building Rust release binaries for $GV_SHA"
cd "$PROJECT_DIR"
cargo build --release -p sc-server

log "building sc-web production bundle"
cd "$PROJECT_DIR/sc-web"
pnpm install --frozen-lockfile
pnpm build

cd "$PROJECT_DIR"
sha256sum target/release/sc-server > "$(checksums_path)"
write_local_manifest ok

echo "$GV_SHA" > "$RELEASE_DIR/RELEASE_COMMIT"
log "release artifacts ready in $RELEASE_DIR"
log "manifest: $(manifest_path)"
log "checksums: $(checksums_path)"
