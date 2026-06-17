# Games Vault — Scripts

## dev-start.sh

One-command launcher for the full development stack.

```bash
./scripts/dev-start.sh           # start all services
./scripts/dev-start.sh --reset   # clean .next cache + restart
./scripts/dev-start.sh --pair    # one-time server pairing (needs sign-in)
./scripts/dev-start.sh status    # show what's running
./scripts/dev-start.sh stop      # kill everything
```

### First-time setup

1. Build the binaries:
   ```bash
   cargo build --release -p gv-server -p gv-worker
   ```

2. Make sure Postgres is running on port 5433.

3. Set up gv-web `.env.local` (copy from root `.env.example`):
   ```bash
   cp .env.example gv-web/.env.local
   # Edit AUTH_SECRET, DATABASE_URL, LAN_USER, LAN_PASS
   ```

4. Start gv-web, sign in, then pair gv-server:
   ```bash
   ./scripts/dev-start.sh        # starts gv-web
   # Sign in at http://localhost:3000
   ./scripts/dev-start.sh --pair # generates config for gv-server
   ./scripts/dev-start.sh stop   # stop everything
   ./scripts/dev-start.sh        # start full stack
   ```

### Daily use

```bash
./scripts/dev-start.sh           # start everything
./scripts/dev-start.sh --reset   # after pulling new code / dependency changes
./scripts/dev-start.sh stop      # done for the day
```

### Logs

All service output goes to `/dev/shm/gv-logs/`:
- `gv-web.log` — Next.js dev server
- `gv-server.log` — gv-server (polling, worker spawn, SDP relay)

## Systemd (production)

Generate and install systemd units:

```bash
./scripts/dev-start.sh --install-systemd
sudo systemctl enable --now gv-web gv-server
```

Note: systemd units require a production build (`next build`) and the
`games-vault` user to exist.
