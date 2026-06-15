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
WORKER_BIN="${GV_WORKER_BIN:-$PROJECT_DIR/target/release/gv-worker}"
CORES_DIR="${GV_CORES_DIR:-/srv/storage/games/cores}"
SAVE_DIR="${GV_SAVE_DIR:-/srv/storage/games/saves}"
SYSTEM_DIR="${GV_SYSTEM_DIR:-/srv/storage/games/system}"

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

# ── Status ──────────────────────────────────────────────────────────────
cmd_status() {
    echo ""
    echo "=== Games Vault ==="
    if pg_isready -h 127.0.0.1 -p "$PG_PORT" >/dev/null 2>&1; then
        echo -e "  Postgres  ${GREEN}ok${NC}  :$PG_PORT/$PG_DB"
    else
        echo -e "  Postgres  ${RED}DOWN${NC}"
    fi
    if curl -sf "http://localhost:$WEB_PORT/api/health" >/dev/null 2>&1; then
        echo -e "  gv-web    ${GREEN}ok${NC}  http://localhost:$WEB_PORT"
    else
        echo -e "  gv-web    ${RED}DOWN${NC}"
    fi
    if pgrep -f 'gv-server start' >/dev/null 2>&1; then
        local sid=$(grep server_id "$HOME/.config/games-vault/config.toml" 2>/dev/null | cut -d'"' -f2)
        echo -e "  gv-server ${GREEN}ok${NC}  server_id=${sid:-?}"
    else
        echo -e "  gv-server ${RED}DOWN${NC}"
    fi
    if pgrep -f 'gv-worker [0-9]' >/dev/null 2>&1; then
        echo -e "  gv-worker ${GREEN}ok${NC}  (standalone)"
    else
        echo -e "  gv-worker ${YELLOW}idle${NC}  (on demand)"
    fi
    echo ""
    echo "Library: http://localhost:$WEB_PORT"
    echo "Dev:     http://localhost:$WEB_PORT/dev"
    echo "Logs:    $LOG_DIR"
    echo ""
}

# ── Stop ────────────────────────────────────────────────────────────────
cmd_stop() {
    log "Stopping..."
    pkill -f 'gv-server start' 2>/dev/null && log "  gv-server stopped" || true
    pkill -f 'gv-worker [0-9]' 2>/dev/null && log "  gv-worker stopped" || true
    pkill -f 'next-server' 2>/dev/null && log "  gv-web stopped" || true
    rm -f /tmp/gv-worker-pids/*.pid 2>/dev/null || true
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
        err "Build: cargo build --release -p gv-worker"
        exit 1
    fi

    local SERVER_BIN="$PROJECT_DIR/target/release/gv-server"
    if [ ! -f "$SERVER_BIN" ]; then
        err "gv-server binary not found: $SERVER_BIN"
        err "Build: cargo build --release -p gv-server"
        exit 1
    fi

    if [ "$reset" = "--reset" ]; then
        log "Resetting dev environment..."
        cmd_stop
        rm -rf "$PROJECT_DIR/gv-web/.next"
        log "Cleaned .next build cache"
    fi

    # ── gv-web ──────────────────────────────────────────────────────
    if ! curl -sf "http://localhost:$WEB_PORT/api/health" >/dev/null 2>&1; then
        log "Starting gv-web..."
        cd "$PROJECT_DIR/gv-web"
        rm -rf .next
        pnpm dev > "$LOG_DIR/gv-web.log" 2>&1 &
        cd "$PROJECT_DIR"
        health_check "http://localhost:$WEB_PORT/api/health" "gv-web"
    else
        log "gv-web already running"
    fi

    # ── gv-server config ────────────────────────────────────────────
    local CFG="$HOME/.config/games-vault/config.toml"
    if [ ! -f "$CFG" ]; then
        err "gv-server config not found: $CFG"
        err ""
        err "One-time setup:"
        err "  1. Sign in at http://localhost:$WEB_PORT"
        err "  2. Run: $0 --pair"
        exit 1
    fi
    log "Config: $CFG"

    # ── gv-server ───────────────────────────────────────────────────
    if ! pgrep -f 'gv-server start' >/dev/null 2>&1; then
        log "Starting gv-server..."
        GV_WORKER_BIN="$WORKER_BIN" \
        GV_CORES_DIR="$CORES_DIR" \
        GV_ROM_ROOTS="$ROM_ROOTS" \
        GV_SAVE_DIR="$SAVE_DIR" \
        GV_SYSTEM_DIR="$SYSTEM_DIR" \
            "$SERVER_BIN" start --gv-web-url "http://localhost:$WEB_PORT" \
            > "$LOG_DIR/gv-server.log" 2>&1 &
        sleep 2
        if pgrep -f 'gv-server start' >/dev/null 2>&1; then
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

# ── Pair (one-time setup) ───────────────────────────────────────────────
cmd_pair() {
    local CFG="$HOME/.config/games-vault/config.toml"
    mkdir -p "$(dirname "$CFG")"

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

    cat > "$CFG" << EOF
[gv_web]
url = "http://localhost:$WEB_PORT"

[auth]
api_key = "$KEY"
server_id = "$SID"

[rom]
roots = ["$ROM_ROOTS"]
EOF
    log "Server paired: $SID"
    log "Config saved: $CFG"
}

# ── Dispatch ────────────────────────────────────────────────────────────
case "${1:-start}" in
    start)             cmd_start "" ;;
    --reset)           cmd_start "--reset" ;;
    --pair)            cmd_pair ;;
    status|--status)   cmd_status ;;
    stop|--stop)       cmd_stop ;;
    *)
        echo "Usage: $0 [start|--reset|--pair|status|stop]"
        echo ""
        echo "  start        Start all services (default)"
        echo "  --reset      Clean .next cache, restart"
        echo "  --pair       One-time pairing with gv-web (needs auth)"
        echo "  status       Show what's running"
        echo "  stop         Kill all services"
        exit 1
        ;;
esac
