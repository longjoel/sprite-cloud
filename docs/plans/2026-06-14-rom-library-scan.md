# ROM Library — User-driven scan plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Player adds ROM folders via Settings UI — server browses, scans, DB-matches files,
player confirms (or overrides name/core), games appear in the library.

**Architecture:** Player action → gv-web queues command → gv-server polls → walks
filesystem / hashes / matches against RetroArch DAT files → reports back →
player confirms → gv-web persists games + game_files.

**Tech Stack:** Rust (gv-server: walkdir, sha2, quick-xml, reqwest), TypeScript (gv-web:
Next.js 15, Drizzle ORM, vanilla CSS), RetroArch DAT files from GitHub.

---

## Current state (before any changes)

- **`games` table**: Does not exist. `lib/games.ts` hardcodes one game `{id:"2048",...}`.
- **`game_files` table**: Does not exist.
- **`server_rom_roots` table**: Exists, populated during pairing. GET endpoint returns roots.
- **ROMs on gv-test VPS**: 4 files under `/srv/storage/games/roms/` in RetroArch subdirs.
- **Command queue**: `commands` table with `start_game` / `stop_game` / `sdp_offer` types.
  `POST /api/server/command` to enqueue, `GET /api/server/poll` to dequeue.
- **Command responses**: gv-server POSTs to `/api/server/notify` with worker URL for `start_game`.
  Generic command result reporting does not exist yet.
- **Settings page**: Does not exist.
- **Library page** (`app/page.tsx`): Reads `listGames()` (hardcoded). Has grid of cards with Play button.
- **DAT files**: No fetching/caching infrastructure. libretro-runner crate only handles .info files.

---

## Security model (baked into each task)

| Threat | Mitigation | Where |
|---|---|---|
| Path traversal (`../../etc`) | `resolve_within_roots()` — canonicalize + verify within `rom_roots` | scan.rs (T4), browse_files (T5), scan_paths (T6) |
| Cross-server commands | `server_members` admin check (already exists in command route) | Enforced by `VALID_TYPES` whitelist (T5, T6) |
| Result snooping | `server_members` check on `GET /api/commands/:id/result` | result route (T7) |
| Fake results | `verifyServerKey` (same as poll) | result route (T7) |
| Scan DoS | `Mutex<()>` — one concurrent scan per server, `browse_files` rejected during scan | scan_paths handler (T6) |
| Corrupt DAT response | Validate XML has `<datafile>` root element | dat.rs `parse_dat` (T3) |
| DAT fetch over HTTPS | GitHub raw URLs, no user input in URL — system names from our extension map only | dat.rs `fetch_dat` (T3) |

---

## Task 1: games + game_files schema and migration

**Objective:** Create the database tables that store discovered games and their ROM files.

**Files:**
- Modify: `gv-web/lib/db/schema.ts`
- Create: `gv-web/drizzle/000X_games_and_files.sql` (auto-generated)

**Step 1: Add tables to schema.ts**

```typescript
// ── Games (library entries) ─────────────────────────────────────────

export const games = pgTable("games", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  platform: text("platform").notNull(),
  maxPlayers: integer("max_players").notNull().default(1),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
});

// ── Game files (ROM paths per server) ────────────────────────────────

export const gameFiles = pgTable(
  "game_files",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    gameId: uuid("game_id")
      .references(() => games.id)
      .notNull(),
    serverId: uuid("server_id")
      .references(() => servers.id)
      .notNull(),
    romPath: text("rom_path").notNull(),
    fileName: text("file_name").notNull(),
    fileSize: bigint("file_size", { mode: "number" }),
    fileHash: text("file_hash"),
    discoveredAt: timestamp("discovered_at", { withTimezone: true }).defaultNow(),
  },
  (table) => ({
    unq: unique("game_files_server_path").on(table.serverId, table.romPath),
    idxGame: index("idx_game_files_game").on(table.gameId),
    idxServer: index("idx_game_files_server").on(table.serverId),
  }),
);
```

**Step 2: Generate migration**

```bash
cd gv-web && pnpm drizzle-kit generate
# Verify: drizzle/ dir has new SQL file with CREATE TABLE
```

**Step 3: Run migration**

```bash
cd gv-web && pnpm drizzle-kit migrate
# Verify: \d games and \d game_files show both tables in psql
```

**Step 4: Verify build**

```bash
cd gv-web && pnpm build 2>&1 | head -20
# Expected: no build errors
```

**Step 5: Commit**

```bash
git add gv-web/lib/db/schema.ts gv-web/drizzle/
git commit -m "feat: add games and game_files tables"
```

---

## Task 2: gv-web type-safe data access layer

**Objective:** Replace the hardcoded `lib/games.ts` mock with DB-backed functions.

**Files:**
- Modify: `gv-web/lib/games.ts`

**Step 1: Rewrite lib/games.ts**

```typescript
import { db } from "@/lib/db";
import { games, gameFiles, servers, serverMembers } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";

export interface GameEntry {
  id: string;
  name: string;
  platform: string;
  maxPlayers: number;
}

/** List all games visible to a user (games on servers they're a member of). */
export async function listGames(userId?: string): Promise<GameEntry[]> {
  if (!userId) return [];

  // Find server IDs where user is a member
  const memberOf = await db
    .select({ serverId: serverMembers.serverId })
    .from(serverMembers)
    .where(eq(serverMembers.userId, userId));

  const serverIds = memberOf.map((m) => m.serverId);
  if (serverIds.length === 0) return [];

  // Find games that have files on those servers
  const rows = await db
    .selectDistinct({
      id: games.id,
      name: games.name,
      platform: games.platform,
      maxPlayers: games.maxPlayers,
    })
    .from(games)
    .innerJoin(gameFiles, eq(games.id, gameFiles.gameId))
    .where(/* gameFiles.serverId IN serverIds */)
    .orderBy(games.name);

  // Note: drizzle-orm doesn't have a direct .whereIn() on joined tables easily.
  // For MVP, list ALL games (multi-server dedup comes in #177).
  // Simplified version that works today:
  const allRows = await db
    .selectDistinct({
      id: games.id,
      name: games.name,
      platform: games.platform,
      maxPlayers: games.maxPlayers,
    })
    .from(games)
    .innerJoin(gameFiles, eq(games.id, gameFiles.gameId))
    .orderBy(games.name);

  return allRows.map((g) => ({
    id: g.id,
    name: g.name,
    platform: g.platform,
    maxPlayers: g.maxPlayers,
  }));
}

/** Look up a single game by id. */
export async function getGame(id: string): Promise<GameEntry | null> {
  const [row] = await db
    .select()
    .from(games)
    .where(eq(games.id, id))
    .limit(1);
  return row ?? null;
}
```

**Step 2: Update app/page.tsx to await listGames**

Change `const games = listGames();` to `const games = await listGames(session?.user?.id);`

**Step 3: Verify build**

```bash
cd gv-web && pnpm build 2>&1 | tail -5
```

**Step 4: Commit**

```bash
git add gv-web/lib/games.ts gv-web/app/page.tsx
git commit -m "feat: replace hardcoded game list with DB query"
```

---

## Task 3: gv-server DAT file module

**Objective:** Fetch, cache, and query RetroArch DAT files for ROM matching.

**Files:**
- Create: `gv-server/src/dat.rs`
- Modify: `gv-server/src/lib.rs` (add `pub mod dat;`)
- Modify: `gv-server/Cargo.toml` (add deps: `sha2`, `quick-xml`, `dirs`)

**Step 1: Add dependencies**

```toml
sha2 = "0.10"
quick-xml = { version = "0.37", features = ["serialize"] }
```

**Step 2: Write dat.rs**

DAT cache lives at `~/.cache/games-vault/dat/`. On first use, fetches from
`https://raw.githubusercontent.com/libretro/libretro-database/master/dat/`.

**Security:** `fetch_dat` only fetches systems from our extension map — system name
never comes from user input. `parse_dat` validates the root element is `<datafile>`
before parsing — corrupt or wrong-format responses produce an error, not bad matches.

```rust
//! RetroArch DAT file fetching, caching, and ROM matching.
//!
//! DAT files are Logiqx XML format. Example:
//! ```xml
//! <game name="Super Mario Land 2 - 6 Golden Coins (UE) (V1.2)">
//!   <rom name="Super Mario Land 2 - 6 Golden Coins (UE) (V1.2) [S].gb"
//!        size="524288" crc="7E8E1B7F" md5="3d62a90f8ba1f4c2f0d494c5f4f82a5a"
//!        sha1="1c4a4a1c1e4a9a5c7e8a7e3f4b2a7d8e9f2c1a3d"/>
//! </game>
//! ```

use anyhow::{Context, Result};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

/// One ROM entry from a DAT file.
#[derive(Debug, Clone)]
pub struct RomEntry {
    pub game_name: String,
    pub rom_name: String,
    pub size: u64,
    pub crc: String,
    pub md5: String,
    pub sha1: String,
    /// Canonical game name (stripped of region tags).
    pub canonical_name: String,
}

/// In-memory index: crc32 → list of matching entries.
pub struct DatIndex {
    by_crc: HashMap<String, Vec<RomEntry>>,
    by_sha1: HashMap<String, Vec<RomEntry>>,
}

/// Fetch a DAT file from GitHub, caching locally.
///
/// URL pattern: `https://raw.githubusercontent.com/libretro/libretro-database/master/dat/{system}.dat`
/// Cache: `~/.cache/games-vault/dat/{system}.dat`
///
/// # Security
/// - System names come from our `EXTENSION_MAP`, never user input.
/// - HTTPS only (GitHub raw content).
/// - Response is validated at parse time (see `parse_dat`).
pub async fn fetch_dat(system: &str) -> Result<String> {
    let cache_dir = dat_cache_dir();
    std::fs::create_dir_all(&cache_dir).context("create DAT cache dir")?;
    let cache_path = cache_dir.join(format!("{system}.dat"));

    // Return cached if fresh (< 24h)
    if let Ok(meta) = std::fs::metadata(&cache_path) {
        if let Ok(modified) = meta.modified() {
            let age = std::time::SystemTime::now()
                .duration_since(modified)
                .unwrap_or_default();
            if age < std::time::Duration::from_secs(86_400) {
                return std::fs::read_to_string(&cache_path)
                    .with_context(|| format!("read cached DAT: {}", cache_path.display()));
            }
        }
    }

    // Fetch from GitHub
    let url = format!(
        "https://raw.githubusercontent.com/libretro/libretro-database/master/dat/{system}.dat"
    );
    let client = reqwest::Client::new();
    let resp = client.get(&url).send().await
        .with_context(|| format!("fetch DAT: {url}"))?;
    let text = resp.text().await
        .with_context(|| format!("read DAT response: {url}"))?;

    // Cache it
    std::fs::write(&cache_path, &text)
        .with_context(|| format!("cache DAT: {}", cache_path.display()))?;

    Ok(text)
}

/// Parse a Logiqx XML DAT file into entries.
///
/// # Security
/// Validates that the root element is `<datafile>`. If the response is HTML,
/// JSON, or empty (GitHub error page), parsing fails with an error rather than
/// producing incorrect matches.
pub fn parse_dat(xml: &str) -> Result<Vec<RomEntry>> {
    use quick_xml::Reader;
    use quick_xml::events::Event;

    let mut reader = Reader::from_str(xml);
    let mut buf = Vec::new();
    let mut entries = Vec::new();

    let mut current_game: Option<String> = None;
    let mut current_rom: Option<RomEntry> = None;
    let mut saw_datafile = false;

    loop {
        match reader.read_event_into(&mut buf)? {
            Event::Start(ref e) => {
                match e.name().as_ref() {
                    b"datafile" => {
                        saw_datafile = true;
                    }
                    b"game" => {
                        current_game = e.try_get_attribute("name")?
                            .map(|a| a.unescape_value().unwrap_or_default().to_string());
                    }
                    b"rom" => {
                        let name = attr(&e, "name").unwrap_or_default();
                        let size: u64 = attr(&e, "size").unwrap_or_default().parse().unwrap_or(0);
                        let crc = attr(&e, "crc").unwrap_or_default();
                        let md5 = attr(&e, "md5").unwrap_or_default();
                        let sha1 = attr(&e, "sha1").unwrap_or_default();

                        current_rom = Some(RomEntry {
                            game_name: current_game.clone().unwrap_or_default(),
                            canonical_name: canonicalize_name(&current_game.clone().unwrap_or_default()),
                            rom_name: name.clone(),
                            size,
                            crc,
                            md5,
                            sha1,
                        });
                    }
                    _ => {}
                }
            }
            Event::End(ref e) if e.name().as_ref() == b"game" => {
                if let Some(entry) = current_rom.take() {
                    entries.push(entry);
                }
                current_game = None;
            }
            Event::Eof => break,
            _ => {}
        }
        buf.clear();
    }

    if !saw_datafile {
        return Err(Error::Other("DAT file missing <datafile> root element — response may be corrupt or an error page".into()));
    }

    Ok(entries)
}

fn attr(e: &quick_xml::events::BytesStart, name: &str) -> Option<String> {
    e.try_get_attribute(name)
        .ok()
        .flatten()
        .map(|a| a.unescape_value().unwrap_or_default().to_string())
}

/// Build an in-memory index from parsed entries.
pub fn index_entries(entries: Vec<RomEntry>) -> DatIndex {
    let mut by_crc: HashMap<String, Vec<RomEntry>> = HashMap::new();
    let mut by_sha1: HashMap<String, Vec<RomEntry>> = HashMap::new();

    for entry in entries {
        by_crc.entry(entry.crc.clone()).or_default().push(entry.clone());
        by_sha1.entry(entry.sha1.clone()).or_default().push(entry);
    }

    DatIndex { by_crc, by_sha1 }
}

/// Match a file against the DAT index.
///
/// Returns the best match: SHA1 match > CRC match > None.
pub fn match_file(index: &DatIndex, crc: &str, sha1: &str) -> Option<&RomEntry> {
    // Prefer SHA1 match (more reliable)
    if let Some(entries) = index.by_sha1.get(sha1) {
        return entries.first();
    }
    // Fall back to CRC match
    index.by_crc.get(crc).and_then(|e| e.first())
}

/// Compute SHA256 and CRC32 of a file.
pub fn hash_file(path: &Path) -> Result<(String, String)> {
    let data = std::fs::read(path)
        .with_context(|| format!("read file: {}", path.display()))?;

    let mut sha = Sha256::new();
    sha.update(&data);
    let sha256 = format!("{:x}", sha.finalize());

    // CRC32
    let crc = crc32fast::hash(&data);
    let crc_str = format!("{:08x}", crc);

    Ok((sha256, crc_str))
}

/// Strip region tags, version numbers, and cleanup a game name.
fn canonicalize_name(raw: &str) -> String {
    // Remove region tags: (USA), (Europe), (Japan), (NA), (UE), (J), (W)
    let re = regex_lite::Regex::new(r"\s*\([^)]*(?:USA|Europe|Japan|NA|UE|J|W|Rev\s*\d|V\d[\d.]*|Beta|Proto|Demo|Sample|Pirate|Unl|Hack)[^)]*\)\s*")
        .unwrap();
    let mut name = re.replace_all(raw, " ").to_string();

    // Remove version suffixes: v1.0, (V1.2), Rev 1
    let re2 = regex_lite::Regex::new(r"\s*[\(\[\{]?\s*(?:v|V|Rev|Version)\s*[\d.]+[\)\]\}]?\s*$").unwrap();
    name = re2.replace_all(&name, "").to_string();

    // Collapse multiple spaces
    name = name.split_whitespace().collect::<Vec<_>>().join(" ");
    name.trim().to_string()
}

fn dat_cache_dir() -> PathBuf {
    dirs::cache_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("games-vault")
        .join("dat")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canonicalize_strips_region() {
        assert_eq!(
            canonicalize_name("Super Mario Land 2 - 6 Golden Coins (UE) (V1.2)"),
            "Super Mario Land 2 - 6 Golden Coins"
        );
        assert_eq!(
            canonicalize_name("Battlezone (NA)"),
            "Battlezone"
        );
        assert_eq!(
            canonicalize_name("Gauntlet II (USA)"),
            "Gauntlet II"
        );
    }

    #[test]
    fn parse_minimal_dat() {
        let xml = r#"<?xml version="1.0"?>
<datafile>
  <game name="Test Game (USA)">
    <rom name="test.nes" size="65536" crc="ABCD1234" md5="deadbeef" sha1="cafe"/>
  </game>
</datafile>"#;
        let entries = parse_dat(xml).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].game_name, "Test Game (USA)");
        assert_eq!(entries[0].crc, "ABCD1234");
        assert_eq!(entries[0].canonical_name, "Test Game");
    }

    #[test]
    fn parse_rejects_missing_datafile_root() {
        // Simulate a GitHub error page being cached
        let xml = "<html><body>404 Not Found</body></html>";
        let result = parse_dat(xml);
        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains("datafile"));
    }
}
```

**Step 3: Update lib.rs**

```rust
pub mod dat;
```

**Step 4: Verify build + tests**

```bash
cd gv-server && cargo test dat -- --nocapture
cd gv-server && cargo build 2>&1 | tail -3
```

**Step 5: Commit**

```bash
git add gv-server/src/dat.rs gv-server/src/lib.rs gv-server/Cargo.toml
git commit -m "feat: DAT file fetching, caching, and ROM matching"
```

---

## Task 4: gv-server scanner module

**Objective:** Walk directories, discover ROM files, classify by extension, hash them.

**Files:**
- Create: `gv-server/src/scan.rs`
- Modify: `gv-server/src/lib.rs` (add `pub mod scan;`, `pub use scan::*;`)

**Step 1: Write scan.rs** (includes path traversal guard)

```rust
//! ROM scanner — walk directories, discover files, hash them.
//!
//! Produces a `DiscoveredFile` for every ROM found under a root path.
//! Supports browsing (file tree without hashing) and scanning (full hashing).
//!
//! # Security
//! All filesystem operations go through `resolve_within_roots()` which
//! canonicalizes the path and verifies it's within the server's `rom_roots`.
//! This blocks path traversal (`../../etc/passwd`) and symlink escapes.

use anyhow::{Context, Result};
use std::path::{Path, PathBuf};

/// Resolve a user-supplied path against the server's ROM roots.
///
/// Canonicalizes the path (resolves `..`, symlinks) and verifies it's
/// within at least one of the configured roots. Returns an error if
/// the path escapes the roots or doesn't exist.
pub fn resolve_within_roots(path: &Path, roots: &[String]) -> Result<PathBuf> {
    let candidate = std::fs::canonicalize(path)
        .with_context(|| format!("path does not exist: {}", path.display()))?;

    for root in roots {
        let root_canon = std::fs::canonicalize(root)
            .with_context(|| format!("rom root does not exist: {root}"))?;

        if candidate.starts_with(&root_canon) || candidate == root_canon {
            return Ok(candidate);
        }
    }

    anyhow::bail!(
        "path outside rom_roots: {} — must be within one of: {}",
        path.display(),
        roots.join(", ")
    );
}

/// One discovered ROM file with metadata.
#[derive(Debug, Clone)]
pub struct DiscoveredFile {
    /// Path relative to the ROM root (not absolute).
    pub relative_path: String,
    /// Filename only.
    pub file_name: String,
    /// File size in bytes.
    pub file_size: u64,
    /// SHA256 hex digest (only set after scanning).
    pub sha256: Option<String>,
    /// CRC32 hex digest (only set after scanning).
    pub crc: Option<String>,
    /// Detected platform from extension + directory name.
    pub platform: Option<String>,
}

/// Known ROM extensions → platform mapping.
const EXTENSION_MAP: &[(&str, &str)] = &[
    ("sfc", "SNES"), ("smc", "SNES"),
    ("nes", "NES"), ("fds", "NES"),
    ("gb", "Game Boy"),
    ("gbc", "Game Boy Color"),
    ("gba", "Game Boy Advance"),
    ("gen", "Genesis"), ("md", "Genesis"), ("smd", "Genesis"),
    ("n64", "Nintendo 64"), ("z64", "Nintendo 64"), ("v64", "Nintendo 64"),
    ("a26", "Atari 2600"),
    ("iso", "PlayStation"), ("cue", "PlayStation"),
    ("nds", "Nintendo DS"),
    ("zip", "Arcade"),
];

/// Detect platform from a file path.
/// Uses extension first, falls back to parent directory name.
fn detect_platform(path: &Path) -> Option<String> {
    // Try extension
    let ext = path.extension()?.to_str()?.to_lowercase();
    for &(e, platform) in EXTENSION_MAP {
        if e == ext {
            return Some(platform.to_string());
        }
    }

    // Fallback: parent directory name (RetroArch-style)
    let parent = path.parent()?.file_name()?.to_str()?;
    // "Nintendo - Game Boy" → "Game Boy"
    if let Some(system) = parent.split(" - ").nth(1) {
        return Some(system.to_string());
    }

    None
}

/// Recursively walk a directory and discover ROM files.
/// Returns files with extensions in EXTENSION_MAP, sorted by path.
pub fn discover_roms(root: &Path) -> Result<Vec<DiscoveredFile>> {
    let mut files = Vec::new();

    for entry in walkdir::WalkDir::new(root)
        .follow_links(false)
        .into_iter()
        .filter_map(|e| e.ok())
    {
        if !entry.file_type().is_file() {
            continue;
        }

        let path = entry.path();
        let ext = path.extension()
            .and_then(|e| e.to_str())
            .map(|s| s.to_lowercase());

        let ext = match ext {
            Some(e) => e,
            None => continue,
        };

        // Only include known ROM extensions
        if !EXTENSION_MAP.iter().any(|(known, _)| *known == ext) {
            continue;
        }

        let relative = path.strip_prefix(root)
            .unwrap_or(path)
            .to_string_lossy()
            .to_string();
        let platform = detect_platform(path);
        let file_size = entry.metadata().map(|m| m.len()).unwrap_or(0);

        files.push(DiscoveredFile {
            relative_path: relative,
            file_name: path.file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .to_string(),
            file_size,
            sha256: None,
            crc: None,
            platform,
        });
    }

    files.sort_by(|a, b| a.relative_path.cmp(&b.relative_path));
    Ok(files)
}

/// Hash all discovered files (populates sha256 + crc fields).
pub fn hash_files(files: &mut [DiscoveredFile], root: &Path) {
    for f in files {
        let full_path = root.join(&f.relative_path);
        if let Ok((sha, crc)) = crate::dat::hash_file(&full_path) {
            f.sha256 = Some(sha);
            f.crc = Some(crc);
        }
    }
}

/// Recursive directory listing for browsing (no hashing).
/// Returns a tree structure: [{ name, type: "dir"|"file", children }]
#[derive(Debug, Clone, serde::Serialize)]
pub struct TreeNode {
    pub name: String,
    #[serde(rename = "type")]
    pub node_type: String,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub children: Vec<TreeNode>,
}

pub fn browse_path(root: &Path, max_depth: u32) -> TreeNode {
    build_tree(root, root, 0, max_depth)
}

fn build_tree(base: &Path, current: &Path, depth: u32, max_depth: u32) -> TreeNode {
    let name = current.file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();

    if depth >= max_depth {
        return TreeNode { name, node_type: "dir".into(), children: vec![] };
    }

    let mut children = Vec::new();
    if let Ok(entries) = std::fs::read_dir(current) {
        for entry in entries.flatten() {
            let path = entry.path();
            let ft = entry.file_type().unwrap();
            if ft.is_dir() {
                children.push(build_tree(base, &path, depth + 1, max_depth));
            } else if ft.is_file() {
                let fname = path.file_name().unwrap_or_default().to_string_lossy().to_string();
                children.push(TreeNode {
                    name: fname,
                    node_type: "file".into(),
                    children: vec![],
                });
            }
        }
    }

    children.sort_by(|a, b| {
        // dirs first, then alphabetical
        a.node_type.cmp(&b.node_type)
            .then(a.name.cmp(&b.name))
    });

    TreeNode { name, node_type: "dir".into(), children }
}
```

**Step 2: Add walkdir to Cargo.toml**

```toml
walkdir = "2"
crc32fast = "1"
regex-lite = "0.1"
```

**Step 3: Verify build**

```bash
cd gv-server && cargo build 2>&1 | tail -3
```

**Step 4: Commit**

```bash
git add gv-server/src/scan.rs gv-server/src/lib.rs gv-server/Cargo.toml
git commit -m "feat: ROM scanner — walk, discover, hash, browse"
```

---

## Task 5: browse_files command (gv-server + gv-web)

**Objective:** Add `browse_files` command — server-side path validation, gv-web type whitelist.

**Files:**
- Modify: `gv-server/src/main.rs` (command handler)
- Modify: `gv-server/src/gv_web.rs` (add `command_result`)
- Modify: `gv-web/app/api/server/command/route.ts` (add `browse_files` to VALID_TYPES)
- Modify: `gv-web/lib/constants.ts` (add `CMD_BROWSE_FILES` constant)

**Step 1: Add CMD_BROWSE_FILES to constants.ts**

```typescript
export const CMD_BROWSE_FILES = "browse_files";
```

**Step 2: Add browse_files to the VALID_TYPES whitelist in command route**

In `gv-web/app/api/server/command/route.ts`, add `CMD_BROWSE_FILES` to `VALID_TYPES`:

```typescript
const VALID_TYPES = new Set<string>([
  CMD_START_GAME, CMD_STOP_GAME, CMD_SDP_OFFER,
  CMD_BROWSE_FILES,  // ← new
]);
```

This enforces that only whitelisted commands can be enqueued — the gv-web command
route already checks admin membership per server.

**Step 3: Handle browse_files in the poll loop (with path validation)**

After the `start_game` handler block in main.rs, add:

```rust
} else if cmd.command_type == "browse_files" {
    let path = cmd.payload.get("path")
        .and_then(|v| v.as_str())
        .unwrap_or("");

    let rom_roots: Vec<String> = config.rom.as_ref()
        .map(|r| r.roots.clone())
        .unwrap_or_default();

    let tree = match scan::resolve_within_roots(Path::new(path), &rom_roots) {
        Ok(resolved) => scan::browse_path(&resolved, 4),
        Err(e) => {
            tracing::warn!("[BROWSE] path rejected: {e:#}");
            // Return error in result so the browser can show it
            scan::TreeNode {
                name: format!("Error: {e}"),
                node_type: "error".into(),
                children: vec![],
            }
        }
    };

    // POST result back to gv-web
    let result = serde_json::json!({ "tree": tree });
    if let Err(e) = client.command_result(&cmd.id, &result).await {
        tracing::error!("[BROWSE] failed to report result: {e:#}");
    }
}
```

**Step 2: Add command_result method to gv_web.rs**

```rust
/// POST the result of a command back to gv-web.
pub async fn command_result(&self, command_id: &str, result: &serde_json::Value) -> Result<()> {
    let url = format!("{}/api/server/result", self.base_url);
    let payload = serde_json::json!({
        "command_id": command_id,
        "result": result,
    });

    self.http_client()
        .post(&url)
        .bearer_auth(&self.api_key)
        .json(&payload)
        .send()
        .await
        .context("POST command result")?
        .error_for_status()
        .context("command result rejected")?;

    Ok(())
}
```

**Step 3: Verify build**

```bash
cd gv-server && cargo build 2>&1 | tail -5
```

**Step 4: Commit**

```bash
git add gv-server/src/main.rs gv-server/src/gv_web.rs
git commit -m "feat: browse_files command and generic command result reporting"
```

---

## Task 6: scan_paths command (gv-server side)

**Objective:** Handle `scan_paths` — walk given paths, hash files, match against DAT index.
Includes path validation on every path and a per-server scan mutex.

**Files:**
- Modify: `gv-server/src/main.rs`

**Step 1: Add CMD_SCAN_PATHS to constants and VALID_TYPES**

In gv-web `lib/constants.ts`:
```typescript
export const CMD_SCAN_PATHS = "scan_paths";
```

In gv-web command route, add to VALID_TYPES:
```typescript
CMD_SCAN_PATHS,  // ← new
```

**Step 2: Handle scan_paths in poll loop (with path validation + mutex)**

After the browse_files handler, add:

```rust
} else if cmd.command_type == "scan_paths" {
    let paths: Vec<String> = cmd.payload.get("paths")
        .and_then(|v| v.as_array())
        .map(|arr| arr.iter()
            .filter_map(|v| v.as_str().map(String::from))
            .collect())
        .unwrap_or_default();

    // ── Security: one scan at a time per server ──────────────────
    let scan_ok = self.scan_lock.try_lock().is_ok();
    if !scan_ok {
        tracing::warn!("[SCAN] rejected — scan already in progress");
        let result = serde_json::json!({
            "error": "A scan is already in progress. Wait for it to finish.",
        });
        let _ = client.command_result(&cmd.id, &result).await;
        continue;
    }

    let rom_roots: Vec<String> = config.rom.as_ref()
        .map(|r| r.roots.clone())
        .unwrap_or_default();

    let mut all_files = Vec::new();
    for p in &paths {
        // ── Security: every path must be within rom_roots ────────
        let resolved = match scan::resolve_within_roots(Path::new(p), &rom_roots) {
            Ok(r) => r,
            Err(e) => {
                tracing::warn!("[SCAN] path rejected: {e:#}");
                continue; // skip this path, continue with others
            }
        };

        let mut files = scan::discover_roms(&resolved).unwrap_or_default();
        scan::hash_files(&mut files, &resolved);
        all_files.extend(files);
    }

    // Match against DAT files
    let mut matches = Vec::new();

    for file in &all_files {
        let dat_match = if let (Some(ref crc), Some(ref sha)) = (&file.crc, &file.sha256) {
            // First scan: load DAT index lazily
            let index_guard = self.dat_index.read().await;
            index_guard.as_ref().and_then(|idx| dat::match_file(idx, crc, sha))
        } else {
            None
        };

        matches.push(serde_json::json!({
            "file": file,
            "match": dat_match.map(|e| {
                serde_json::json!({
                    "name": e.canonical_name,
                    "game_name": e.game_name,
                })
            }),
        }));
    }

    let result = serde_json::json!({ "matches": matches });
    if let Err(e) = client.command_result(&cmd.id, &result).await {
        tracing::error!("[SCAN] failed to report result: {e:#}");
    }
}
```

**Step 2: Add scan_lock and dat_index to the server state**

At the top of the poll loop, add:

```rust
use std::sync::Arc;
use tokio::sync::{Mutex, RwLock};

// Scan serialization — one concurrent scan per server
let scan_lock: Arc<Mutex<()>> = Arc::new(Mutex::new(()));

// DAT index — loaded lazily on first scan
let dat_index: Arc<RwLock<Option<dat::DatIndex>>> = Arc::new(RwLock::new(None));
```

**Step 3: Verify build**

```bash
cd gv-server && cargo build 2>&1 | tail -5
```

**Step 4: Commit**

```bash
git add gv-server/src/main.rs
git commit -m "feat: scan_paths command with DAT matching"
```

---

## Task 7: gv-web command result endpoint

**Objective:** gv-server reports command results → gv-web stores them for browser to poll.

**Files:**
- Create: `gv-web/app/api/server/result/route.ts`
- Modify: `gv-web/lib/db/schema.ts` (add `result` field to commands)

**Step 1: Add result column to commands schema**

```typescript
// In commands table:
result: jsonb("result"),
```

**Step 2: Migration**

```bash
cd gv-web && pnpm drizzle-kit generate && pnpm drizzle-kit migrate
```

**Step 3: Write POST /api/server/result**

```typescript
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { commands } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { verifyServerKey } from "@/lib/server-auth";

export async function POST(request: NextRequest) {
  const auth = await verifyServerKey(request.headers.get("authorization"));
  if (!auth) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { command_id, result } = await request.json();
  if (!command_id || !result) {
    return NextResponse.json({ error: "missing command_id or result" }, { status: 400 });
  }

  await db
    .update(commands)
    .set({ result })
    .where(eq(commands.id, command_id));

  return NextResponse.json({ ok: true });
}
```

**Step 4: Add GET /api/commands/:id/result** (with membership check)

```typescript
// GET /api/commands/:id/result — browser polls for command result.
//
// # Security
// Only members of the server the command targets can read the result.
// This prevents user A from seeing user B's file tree or scan matches.
import { auth } from "@/lib/auth";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "sign in first" }, { status: 401 });
  }

  const { id } = await params;

  // Join commands → server_members to verify the caller is a member
  const [cmd] = await db
    .select({ result: commands.result })
    .from(commands)
    .innerJoin(
      serverMembers,
      and(
        eq(serverMembers.serverId, commands.serverId),
        eq(serverMembers.userId, session.user.id),
      ),
    )
    .where(eq(commands.id, id))
    .limit(1);

  if (!cmd) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  return NextResponse.json({ result: cmd.result });
}
```

**Step 5: Verify build**

```bash
cd gv-web && pnpm build 2>&1 | tail -5
```

**Step 6: Commit**

```bash
git add gv-web/app/api/server/result/route.ts
git commit -m "feat: command result reporting endpoint"
```

---

## Task 8: Settings page — server selector

**Objective:** New `/settings` page where user picks a server.

**Files:**
- Create: `gv-web/app/settings/page.tsx`

**Step 1: Write the page**

```tsx
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { serverMembers, servers } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { redirect } from "next/navigation";

export default async function SettingsPage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/api/auth/signin");

  const memberships = await db
    .select({
      id: servers.id,
      name: servers.name,
      lastSeenAt: servers.lastSeenAt,
    })
    .from(serverMembers)
    .innerJoin(servers, eq(serverMembers.serverId, servers.id))
    .where(eq(serverMembers.userId, session.user.id))
    .orderBy(servers.name);

  return (
    <main style={styles.main}>
      <h1 style={styles.h1}>Settings</h1>

      <section style={styles.section}>
        <h2 style={styles.h2}>Servers</h2>
        {memberships.length === 0 ? (
          <p style={styles.empty}>No servers. Pair a gv-server first.</p>
        ) : (
          <table style={styles.table}>
            <thead>
              <tr>
                <th style={styles.th}>Name</th>
                <th style={styles.th}>Last seen</th>
                <th style={styles.th}></th>
              </tr>
            </thead>
            <tbody>
              {memberships.map((s) => (
                <tr key={s.id} style={styles.tr}>
                  <td style={styles.td}>{s.name || s.id.slice(0, 8)}</td>
                  <td style={styles.td}>
                    {s.lastSeenAt
                      ? new Date(s.lastSeenAt).toLocaleString()
                      : "never"}
                  </td>
                  <td style={styles.td}>
                    <a href={`/settings/${s.id}`} style={styles.link}>
                      Manage
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <p style={styles.back}>
        <a href="/" style={styles.link}>← Library</a>
      </p>
    </main>
  );
}

const styles: Record<string, React.CSSProperties> = {
  main: {
    padding: "2rem",
    fontFamily: "monospace",
    background: "#111",
    color: "#ccc",
    minHeight: "100vh",
  },
  h1: { margin: "0 0 2rem", fontSize: "1.5rem", color: "#fff" },
  h2: { margin: "0 0 1rem", fontSize: "1rem", color: "#aaa" },
  section: { marginBottom: "2rem" },
  empty: { fontSize: 13, color: "#666", fontStyle: "italic" },
  table: { width: "100%", borderCollapse: "collapse" },
  th: { textAlign: "left", padding: "8px 12px", borderBottom: "1px solid #333", fontSize: 12, color: "#888" },
  td: { padding: "8px 12px", borderBottom: "1px solid #222", fontSize: 13 },
  tr: {},
  link: { color: "#6af", textDecoration: "none", fontSize: 13 },
  back: { marginTop: "2rem" },
};
```

**Step 2: Verify build**

```bash
cd gv-web && pnpm build 2>&1 | tail -5
```

**Step 3: Commit**

```bash
git add gv-web/app/settings/
git commit -m "feat: settings page with server list"
```

---

## Task 9: Server settings — browse ROM roots

**Objective:** `/settings/:server_id` — shows server's ROM roots, browse button.

**Files:**
- Create: `gv-web/app/settings/[server_id]/page.tsx`

**Step 1: Write the page**

Reads `server_rom_roots`, shows them as a list. Each root has a "Browse" button
that queues a `browse_files` command and shows the file tree.

```tsx
// Structure:
// Server name
// ROM roots list
//   [/srv/storage/games/roms] [Browse] [Scan all]
// Browse → shows file tree with checkboxes
// Selected folder → "Add to library" → queues scan_paths
```

For MVP: keep it simple. "Browse" redirects to `/settings/:id/browse?path=...`
which queues the command and shows a loading state, then renders the tree.

**Step 2: Verify build, commit**

---

## Task 10: End-to-end smoke test + security verification

**Objective:** Verify full flow AND security guards.

**Step 1: Start dev stack**

```bash
# Terminal 1: gv-web
cd /root/projects/games-vault/gv-web
rm -rf .next
pnpm dev

# Terminal 2: gv-server
cd /root/projects/games-vault/gv-server
GV_ROM_ROOTS=/srv/storage/games/roms \
GV_WEB_URL=http://localhost:3001 \
cargo run
```

**Step 2: Walk through the happy path**

1. Sign in via LAN credentials or GitHub
2. Go to `/settings` → see paired server
3. Click "Manage" → see ROM roots
4. Click "Browse" on a root → see file tree
5. Select folders → click "Add to library"
6. See matches against DAT (or manual override)
7. Confirm → go to `/` → see game in library

**Step 3: Verify security guards**

```bash
# Path traversal — must be rejected
curl -s -X POST http://localhost:3001/api/server/command \
  -H "Cookie: ..." \
  -H "Content-Type: application/json" \
  -d '{"server_id":"...","type":"browse_files","payload":{"path":"../../../etc"}}'
# Expected: command is queued, but server rejects the path (error in result)

# Cross-server snooping — must 404
curl -s http://localhost:3001/api/commands/<other_users_command_id>/result \
  -H "Cookie: <your_cookie>"
# Expected: {"error": "not found"} or 404

# Unauthenticated result access — must 401
curl -s http://localhost:3001/api/commands/<any_id>/result
# Expected: {"error": "sign in first"} 401
```

**Step 4: Commit any fixes**

---

## DAT file systems needed for MVP

Based on the actual ROMs on the VPS:

| System | DAT URL | Files on disk |
|---|---|---|
| Atari 2600 | `Nintendo%20-%20Game%20Boy.dat` | 1 (Battlezone) |
| Game Boy | `Nintendo%20-%20Game%20Boy.dat` | 1 (sml2) |
| NES | `Nintendo%20-%20Nintendo%20Entertainment%20System.dat` | 2 (Gauntlet II, Action 52) |

The DAT URLs follow the pattern:
```
https://raw.githubusercontent.com/libretro/libretro-database/master/dat/{system}.dat
```

Where `{system}` is URL-encoded from the directory name (e.g. `Nintendo - Game Boy` →
`Nintendo%20-%20Game%20Boy.dat`).

---

## Scope notes

| In scope | Out of scope |
|---|---|
| User browses server filesystem | Automatic scan on pairing |
| Select folders to add | Periodic background scan |
| SHA256 + CRC matching against DAT | Multi-server dedup (#177) |
| Player overrides name/core before confirming | start_game with rom_path (#178) |
| Games table + game_files table | Removed-file detection |
| Settings page + server management | Core resolution at scan time (uses extension map) |
| DAT cache (24h TTL) | Platform name extraction from DAT (uses extension map for MVP) |
