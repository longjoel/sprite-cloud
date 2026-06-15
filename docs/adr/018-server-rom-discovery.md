# ADR 018: Server ROM Discovery

**Status:** Draft  
**Date:** 2026-06-14  

## Context

gv-web currently has no way to know what ROMs are available on a gv-server.
The `start_game` command payload would need to include a ROM path, but gv-web
doesn't know the server's filesystem layout. The v1 app solved this with
`LocalFolders` and `ExternalPath` — fragile, required the admin to manually
configure matching paths on both sides.

The user wants a Plex-style model: each server advertises what it has, and
gv-web builds the library from those advertisements. If the same game exists
on multiple servers, the user picks which one to play on.

## Decision

**gv-server reports one or more ROM root directories during pairing.** gv-web
stores these per-server. A scraper walks each root to discover ROMs. The
library deduplicates across servers and offers a server picker at play time.

### Server advertises ROM roots

When gv-server pairs with gv-web, it includes its ROM root paths in the
claim payload:

```
POST /api/auth/pair/claim
{
  code: "ABCD-EFGH",
  rom_roots: ["/srv/storage/roms", "/mnt/nas/games"]
}
```

gv-server discovers its roots from an env var:

```
GV_ROM_ROOTS=/srv/storage/roms,/mnt/nas/games
```

Or from `config.toml`:
```toml
[rom]
roots = ["/srv/storage/roms", "/mnt/nas/games"]
```

Ordered by priority: env var → config file → empty (no ROMs).

### gv-web stores roots per server

New table:

```sql
server_rom_roots (
  id uuid PK,
  server_id uuid FK → servers.id,
  path text NOT NULL,
  created_at timestamptz DEFAULT now(),
  UNIQUE(server_id, path)
)
```

On pair claim, gv-web upserts the roots: add new ones, remove ones not in the
new list. If `rom_roots` is missing from the claim payload, existing roots are
preserved (backward compat).

### Scraper discovers ROMs

A background job walks each server's roots. For every file found:

1. Resolve system from extension + core mapping table (`.sfc` → SNES, `.gb` → GB)
2. Resolve canonical name from libretro .info or filename heuristic
3. Upsert a `game_files` row:

```sql
game_files (
  id uuid PK,
  game_id uuid FK → games.id,
  server_id uuid FK → servers.id,
  rom_path text NOT NULL,        -- relative to server's rom_root
  file_name text NOT NULL,       -- smw.sfc
  file_size bigint,
  file_hash text,                -- SHA-256, for dedup
  discovered_at timestamptz DEFAULT now(),
  UNIQUE(server_id, rom_path)
)
```

The scraper runs:
- On server pairing (initial discovery)
- Periodically (every hour, configurable)
- Manually via admin trigger ("Rescan ROMs")

### Library deduplication

The `games` table gains an identity key for cross-server matching. ROMs are
grouped into games by one of:

1. **RetroArch serial** — extracted from ROM header (SNES, Genesis, etc.)
2. **SHA-256 hash** — same file on two servers = same game
3. **Filename heuristic** — "Super Mario World (USA).sfc" → "Super Mario World"

Priority: serial > hash > filename. If none match, the ROM becomes its own
game entry.

### Server picker at play time

The library shows one card per game. When a game exists on multiple servers,
the Play button opens a dropdown:

```
┌──────────────────────┐
│ Super Mario World    │
│ SNES · 1p            │
│                      │
│ [Play ▼]             │
│  ├─ vault (local)    │
│  └─ nas (remote)     │
└──────────────────────┘
```

The browser picks a server and sends the `start_game` command targeting
that specific `server_id`. gv-web resolves the full ROM path by joining
the server's rom_root with the relative `rom_path` from `game_files`.

### Launch flow

```
Browser: picks server vault for Super Mario World
  → POST /api/server/command
    { type: "start_game", server_id: "vault-uuid", game_id: "smw-uuid" }

gv-web:
  → SELECT rom_path FROM game_files WHERE game_id AND server_id
  → resolves full path: /srv/storage/roms/snes/smw.sfc
  → queues command: { game_id, rom_path: "/srv/storage/roms/snes/smw.sfc", core_path }

gv-server: polls → receives command → spawns gv-worker --rom .../smw.sfc
```

### Capabilities API (future)

The `rom_roots` field is the first use of a broader pattern: servers
advertise capabilities to gv-web during pairing. Future fields might
include:

- `gpu: true` — has hardware rendering
- `max_workers: 4` — concurrent game limit
- `tags: ["living-room", "4k"]` — for filtering

## Consequences

- **gv-web never needs filesystem access to ROMs.** The server owns its
  storage layout entirely.
- **Adding a server is zero-config for ROMs.** Pair it, roots are reported,
  scraper discovers games automatically.
- **Multi-server redundancy.** Same ROM on two servers = the library
  shows one game with a choice of where to play.
- **Breaking: `start_game` no longer takes a hardcoded `core_path`.**
  Core resolution moves to gv-server (it owns the core inventory).
  The payload becomes `{ game_id, rom_path }` — gv-server resolves
  the core from its own `.info` files.
- **Scraper is optional for MVP.** The immediate value is the `rom_roots`
  table — even without a scraper, gv-web knows each server's ROM root
  and can resolve paths on demand. The scraper can ship later.

## Non-goals

- Scraping ROM metadata (box art, descriptions) — separate from file discovery
- BIOS/firmware management — out of scope
- Remote file transfer between servers — not a Plex sync model
- Network share/SMB scanning — excluded per previous decision

## Implementation plan

See issues:
- #174: Add `rom_roots` to pairing protocol
- #175: Store server ROM roots in gv-web DB
- #176: ROM scraper that walks server roots
- #177: Multi-server game deduplication + picker UI
- #178: Update `start_game` to use resolved ROM paths
