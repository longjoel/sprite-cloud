// ── Shared wall types + pure helpers (CLIENT-SAFE) ────────────────────
//
// Must NOT import anything server-only (db, drizzle, node modules) —
// this module is bundled into client components (FeaturedLive hero).
// The DB-backed getWallGames() lives in lib/wall.ts.

export interface WallGame {
  id: string;
  name: string;
  platform: string;
  maxPlayers: number;
  coverUrl: string;
  serverId: string;
  serverName: string;
  serverOnline: boolean;
  live: boolean;
  players: number;
  viewers: number;
  maxSeats: number;
  freePlay: boolean;
  alwaysOn: boolean;
  /** Stable, human-readable identifier for shareable /watch/<slug> links. */
  slug: string;
  watchUrl: string;
  roomUrl?: string; // present only when live
  /** Unique stable key: `${serverId}:${gameId}` — used for feature rotation. */
  key: string;
}

/** Slugify a game name into a stable shareable identifier. */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

/**
 * Pick the next featured live game for the home-page hero (#781).
 * Round-robins through live games so the hero cycles rather than
 * sticking on one title. First pick prefers an always-on resident;
 * afterwards the next live game after `currentKey` wins (wrap-around).
 * Returns null when nothing is live.
 */
export function pickFeatured(
  games: WallGame[],
  currentKey: string | null,
): WallGame | null {
  const live = games.filter((g) => g.live && g.roomUrl);
  if (live.length === 0) return null;
  if (!currentKey) {
    return live.find((g) => g.alwaysOn) ?? live[0];
  }
  const idx = live.findIndex((g) => g.key === currentKey);
  if (idx === -1) return live.find((g) => g.alwaysOn) ?? live[0];
  return live[(idx + 1) % live.length];
}
