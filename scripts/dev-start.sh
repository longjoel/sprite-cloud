#!/usr/bin/env bash
# ── Games Vault — dev environment launcher ──────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# ── Defaults (all overridable via env) ─────────────────────────────────
PG_PORT="${GV_PG_PORT:-5433}"
PG_DB="${GV_PG_DB:-gv_web_dev}"
PG_USER="${GV_PG_USER:-games-vault}"
WEB_PORT="${GV_WEB_PORT:-3000}"
LOG_DIR="${GV_LOG_DIR:-/dev/shm/gv-logs}"
ROM_ROOTS="${GV_ROM_ROOTS:-/srv/storage/games/roms}"
WORKER_BIN="${GV_WORKER_BIN:-/usr/local/bin/gv-worker}"
SERVER_BIN="${GV_SERVER_BIN:-/usr/local/bin/gv-server}"
CORES_DIR="${GV_CORES_DIR:-/srv/storage/games/cores}"
SAVE_DIR="${GV_SAVE_DIR:-/srv/storage/games/saves}"
SYSTEM_DIR="${GV_SYSTEM_DIR:-/srv/storage/games/system}"
CFG_DIR="${GV_CFG_DIR:-/etc/games-vault}"
GV_USER="${GV_USER:-games-vault}"

mkdir -p "$LOG_DIR"

# ── Helpers ─────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
log()  { echo -e "${GREEN}[gv]${NC} $*"; }
warn() { echo -e "${YELLOW}[gv]${NC} $*"; }
err()  { echo -e "${RED}[gv]${NC} $*"; }

health_check() {
    local url="$1" label="$2" max_attempts="${3:-30}"
    for i in $(seq 1 "$max_attempts"); do
        if curl -sf "$url" >/dev/null 2>&1; then
            log "$label ready ($url)"
            return 0
        fi
        sleep 1
    done
    err "$label failed after ${max_attempts}s — check $LOG_DIR/$label.log"
    return 1
}

# ── Kill all game processes (by user) ───────────────────────────────────
# Because gv-server spawns gv-worker children, all run as GV_USER.
# pkill -u kills zombies, orphans, and defunct processes in one shot.
cmd_killall() {
    log "Killing all game processes (user: $GV_USER)..."
    pkill -9 -u "$GV_USER" 2>/dev/null && log "  Killed all $GV_USER processes" || true
    rm -f /tmp/gv-worker-pids/*.pid 2>/dev/null || true
    log "Done"
}

# ── Status ──────────────────────────────────────────────────────────────
cmd_status() {
    echo ""
    echo "=== Games Vault ==="
    if pg_isready -h 127.0.0.1 -p "$PG_PORT" >/dev/null 2>&1; then
        echo -e "  Postgres  ${GREEN}ok${NC}  :$PG_PORT/$PG_DB"
    else
        echo -e "  Postgres  ${RED}DOWN${NC}"
    fi

    # Use deep health check for gv-web + stack status
    local health
    health=$(curl -sf "http://localhost:$WEB_PORT/api/health" 2>/dev/null || echo "")
    if [ -n "$health" ]; then
        local overall=$(echo "$health" | python3 -c "import sys,json; print(json.load(sys.stdin)['status'])")
        case "$overall" in
            ok)       echo -e "  gv-web    ${GREEN}ok${NC}  http://localhost:$WEB_PORT  (health: $overall)" ;;
            degraded) echo -e "  gv-web    ${YELLOW}ok${NC}  http://localhost:$WEB_PORT  (health: $overall)" ;;
            *)        echo -e "  gv-web    ${RED}DOWN${NC}  http://localhost:$WEB_PORT  (health: $overall)" ;;
        esac
        # Show component breakdown
        echo "$health" | python3 -c "
import sys, json
h = json.load(sys.stdin)
for name, c in sorted(h['components'].items()):
    s = c['status']
    d = c.get('detail', '')
    if s == 'ok':
        print(f'    {name}: {s}')
    elif d:
        print(f'    {name}: \033[1;33m{s}\033[0m — {d}')
    else:
        print(f'    {name}: \033[1;31m{s}\033[0m')
" 2>/dev/null || true
    else
        echo -e "  gv-web    ${RED}DOWN${NC}"
    fi
    if pgrep -u "$GV_USER" -f 'gv-server start' >/dev/null 2>&1; then
        local sid=$(grep server_id "$CFG_DIR/config.toml" 2>/dev/null | cut -d'"' -f2)
        echo -e "  gv-server ${GREEN}ok${NC}  server_id=${sid:-?}  (user: $GV_USER)"
    else
        echo -e "  gv-server ${RED}DOWN${NC}"
    fi
    local workers
    # pgrep exits 1 when no workers are running; status should still report idle.
    workers=$(pgrep -u "$GV_USER" 'gv-worker' 2>/dev/null | wc -l || true)
    if [ "$workers" -gt 0 ]; then
        echo -e "  gv-worker ${GREEN}ok${NC}  ($workers running, user: $GV_USER)"
    else
        echo -e "  gv-worker ${YELLOW}idle${NC}  (on demand, user: $GV_USER)"
    fi
    echo ""
    echo "Library: http://localhost:$WEB_PORT"
    echo "Dev:     http://localhost:$WEB_PORT/dev"
    echo "Logs:    $LOG_DIR"
    echo "User:    $GV_USER (pkill -u $GV_USER to clean all)"
    echo ""
}

# ── Stop ────────────────────────────────────────────────────────────────
cmd_stop() {
    log "Stopping..."
    cmd_killall
    pkill -f 'next-server' 2>/dev/null && log "  gv-web stopped" || true
    log "Done"
}

# ── Start ───────────────────────────────────────────────────────────────
cmd_start() {
    local reset="${1:-}"

    # ── Prerequisites ───────────────────────────────────────────────
    if ! pg_isready -h 127.0.0.1 -p "$PG_PORT" >/dev/null 2>&1; then
        err "Postgres not running on port $PG_PORT"
        err "Start: pg_ctlcluster 16 main start"
        exit 1
    fi
    log "Postgres ready"

    if [ ! -f "$WORKER_BIN" ]; then
        err "gv-worker binary not found: $WORKER_BIN"
        err "Build: cargo build --release -p gv-worker && cp target/release/gv-worker $WORKER_BIN && chown $GV_USER:$GV_USER $WORKER_BIN"
        exit 1
    fi

    if [ ! -f "$SERVER_BIN" ]; then
        err "gv-server binary not found: $SERVER_BIN"
        err "Build: cargo build --release -p gv-server && cp target/release/gv-server $SERVER_BIN && chown $GV_USER:$GV_USER $SERVER_BIN"
        exit 1
    fi

    if [ "$reset" = "--reset" ]; then
        log "Resetting dev environment..."
        cmd_killall
        pkill -f 'next-server' 2>/dev/null || true
        rm -rf "$PROJECT_DIR/gv-web/.next"
        log "Cleaned .next build cache"
    fi

    # ── gv-web ──────────────────────────────────────────────────────
    # Always kill stale next processes — next dev can accumulate stale
    # route registries over long uptime (days), causing 404s on valid API routes.
    local restart_web=false
    if pgrep -f 'next-server' >/dev/null 2>&1; then
        local uptime_secs
        uptime_secs=$(ps -o etimes= -p "$(pgrep -f 'next-server' | head -1)" 2>/dev/null | tr -d ' ' || echo 0)
        if [ "$uptime_secs" -gt 7200 ] 2>/dev/null; then
            log "gv-web uptime ${uptime_secs}s > 2h — forcing restart to clear stale routes"
            restart_web=true
        fi
    fi

    if $restart_web || ! curl -sf "http://localhost:$WEB_PORT/api/health" >/dev/null 2>&1; then
        log "Starting gv-web..."
        pkill -f 'next-server' 2>/dev/null || true
        pkill -f 'next dev' 2>/dev/null || true
        sleep 1
        cd "$PROJECT_DIR/gv-web"
        rm -rf .next
        if [ "${GV_PROD:-0}" = "1" ]; then
            log "Building production gv-web..."
            npx next build > "$LOG_DIR/gv-web-build.log" 2>&1
            npx next start -p "$WEB_PORT" > "$LOG_DIR/gv-web.log" 2>&1 &
        else
            pnpm dev > "$LOG_DIR/gv-web.log" 2>&1 &
        fi
        cd "$PROJECT_DIR"
        health_check "http://localhost:$WEB_PORT/api/health" "gv-web"
        # Verify critical API routes are registered (not just health)
        local route_test
        route_test=$(curl -s -o /dev/null -w "%{http_code}" -X POST \
            -H "Content-Type: application/json" \
            -d '{}' "http://localhost:$WEB_PORT/api/server/command" 2>/dev/null || echo "000")
        if [ "$route_test" = "404" ]; then
            err "API route /api/server/command returned 404 — routes may be stale"
            err "Try: $0 --reset or GV_PROD=1 $0 start"
            exit 1
        fi
        log "API routes verified (POST /api/server/command → $route_test)"
    else
        log "gv-web already running"
    fi

    # ── gv-server config ────────────────────────────────────────────
    if [ ! -f "$CFG_DIR/config.toml" ]; then
        # Try to copy from root's config (one-time migration)
        if [ -f "$HOME/.config/games-vault/config.toml" ]; then
            log "Migrating config to $CFG_DIR/config.toml..."
            mkdir -p "$CFG_DIR"
            cp "$HOME/.config/games-vault/config.toml" "$CFG_DIR/config.toml"
            chown -R "$GV_USER:$GV_USER" "$CFG_DIR"
            chmod 750 "$CFG_DIR"
        else
            err "gv-server config not found: $CFG_DIR/config.toml"
            err ""
            err "One-time setup:"
            err "  1. Sign in at http://localhost:$WEB_PORT"
            err "  2. Run: $0 --pair"
            exit 1
        fi
    fi
    log "Config: $CFG_DIR/config.toml"

    # ── gv-server (runs as GV_USER so children inherit the UID) ─────
    if ! pgrep -u "$GV_USER" -f 'gv-server start' >/dev/null 2>&1; then
        log "Starting gv-server (user: $GV_USER)..."
        runuser -u "$GV_USER" -- env \
            XDG_CONFIG_HOME="$CFG_DIR/.." \
            GV_WORKER_BIN="$WORKER_BIN" \
            GV_CORES_DIR="$CORES_DIR" \
            GV_ROM_ROOTS="$ROM_ROOTS" \
            GV_SAVE_DIR="$SAVE_DIR" \
            GV_SYSTEM_DIR="$SYSTEM_DIR" \
            ALLOWED_ORIGIN="http://localhost:$WEB_PORT" \
            "$SERVER_BIN" start --gv-web-url "http://localhost:$WEB_PORT" \
            > "$LOG_DIR/gv-server.log" 2>&1 &
        sleep 2
        if pgrep -u "$GV_USER" -f 'gv-server start' >/dev/null 2>&1; then
            log "gv-server started"
        else
            err "gv-server failed to start — check $LOG_DIR/gv-server.log"
            exit 1
        fi
    else
        log "gv-server already running"
    fi

    cmd_status
}

# ── Build + install ─────────────────────────────────────────────────────
cmd_build() {
    log "Building release binaries..."
    cd "$PROJECT_DIR"
    cargo build --release -p gv-server -p gv-worker
    cp target/release/gv-server "$SERVER_BIN"
    cp target/release/gv-worker "$WORKER_BIN"
    chown "$GV_USER:$GV_USER" "$SERVER_BIN" "$WORKER_BIN"
    chmod 755 "$SERVER_BIN" "$WORKER_BIN"
    log "Installed to $SERVER_BIN and $WORKER_BIN"
}

# ── Pair (one-time setup) ───────────────────────────────────────────────
cmd_pair() {
    mkdir -p "$CFG_DIR"

    if ! curl -sf "http://localhost:$WEB_PORT/api/health" >/dev/null 2>&1; then
        err "gv-web not running — start it first: $0 start"
        exit 1
    fi

    log "Generating pairing code..."
    local PAIR_RESP
    PAIR_RESP=$(curl -sf -X POST "http://localhost:$WEB_PORT/api/auth/pair/generate" \
        -H "Content-Type: application/json" -d '{"name":"gv-server"}')

    if echo "$PAIR_RESP" | grep -q "sign in"; then
        err "Pairing requires authentication."
        err "Sign in at http://localhost:$WEB_PORT first, then run: $0 --pair"
        exit 1
    fi

    local PAIR_CODE
    PAIR_CODE=$(echo "$PAIR_RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('code',''))")
    if [ -z "$PAIR_CODE" ]; then
        err "Failed to get pairing code: $PAIR_RESP"
        exit 1
    fi
    log "Code: $PAIR_CODE"

    local CLAIM
    CLAIM=$(curl -sf -X POST "http://localhost:$WEB_PORT/api/auth/pair/claim" \
        -H "Content-Type: application/json" -d "{\"code\":\"$PAIR_CODE\"}")

    local SID=$(echo "$CLAIM" | python3 -c "import sys,json; print(json.load(sys.stdin)['server_id'])")
    local KEY=$(echo "$CLAIM" | python3 -c "import sys,json; print(json.load(sys.stdin)['api_key'])")

    cat > "$CFG_DIR/config.toml" << EOF
[gv_web]
url = "http://localhost:$WEB_PORT"

[auth]
api_key = "$KEY"
server_id = "$SID"

[rom]
roots = ["$ROM_ROOTS"]
EOF
    chown "$GV_USER:$GV_USER" "$CFG_DIR/config.toml"
    chmod 640 "$CFG_DIR/config.toml"
    log "Server paired: $SID"
    log "Config saved: $CFG_DIR/config.toml"
}

# ── Dispatch ────────────────────────────────────────────────────────────
case "${1:-start}" in
    start|--reset)  cmd_start "$1" ;;
    --pair)         cmd_pair ;;
    status|--status) cmd_status ;;
    stop|--stop)    cmd_stop ;;
    killall)        cmd_killall ;;
    build|--build)  cmd_build ;;
    *)
        echo "Usage: $0 [start|--reset|--pair|status|stop|killall|build]"
        echo ""
        echo "  start        Start all services (default)"
        echo "  --reset      Kill all, clean .next, restart"
        echo "  --pair       One-time pairing with gv-web (needs auth)"
        echo "  status       Show what's running"
        echo "  stop         Kill all services"
        echo "  killall      Kill all game processes (user: $GV_USER)"
        echo "  build        Build release + install to /usr/local/bin/"
        echo ""
        echo "  GV_PROD=1 $0 start   Use production build (next build + start)"
        echo "                       More durable — no file watchers, predictable routes"
        echo ""
        echo "  Auto-restart: dev server restarts automatically if uptime > 2h"
        echo "  Route check:  /api/server/command probed after startup"
        exit 1
        ;;
esac
