export type LibrarySection = "all" | "favorites" | "recent" | "pins";

export interface LibrarySectionMetadata {
  id: LibrarySection;
  label: string;
}

export const LIBRARY_SECTIONS: readonly LibrarySectionMetadata[] = [
  { id: "all", label: "All" },
  { id: "favorites", label: "Favorites" },
  { id: "recent", label: "Recent" },
  { id: "pins", label: "Pins" },
];

export interface LibraryGame {
  id: string;
  name: string;
  platform: string;
  favorite: boolean;
  pinned: boolean;
  recentRank: number | null;
  serverId: string | null;
  coverUrl: string | null;
}

export interface LibraryFilters {
  section: LibrarySection;
  search?: string;
  platforms?: ReadonlySet<string> | readonly string[];
}

export interface LatestRequestGate {
  beginReset(): number;
  current(): number;
  isCurrent(generation: number): boolean;
}

export function createLatestRequestGate(): LatestRequestGate {
  let generation = 0;
  return {
    beginReset: () => ++generation,
    current: () => generation,
    isCurrent: (candidate) => candidate === generation,
  };
}

export function createLibraryFilters(
  section: LibrarySection,
  search: string,
  platforms?: LibraryFilters["platforms"],
): LibraryFilters {
  return { section, search, platforms };
}

export function createLibraryPageParams(pageSize: number, offset: number, search: string): Record<string, string> {
  return {
    limit: String(pageSize),
    offset: String(offset),
    search: search.trim(),
  };
}

export function normalizeRecentGameIds(response: unknown): string[] {
  if (!response || typeof response !== "object" || !("games" in response) || !Array.isArray(response.games)) return [];
  return response.games
    .map((game) => game && typeof game === "object" && "id" in game ? game.id : null)
    .filter((id): id is string => typeof id === "string");
}

function includesPlatform(platforms: LibraryFilters["platforms"], platform: string): boolean {
  if (!platforms) return true;
  if (Array.isArray(platforms)) return platforms.length === 0 || platforms.includes(platform);
  const selected = platforms as ReadonlySet<string>;
  return selected.size === 0 || selected.has(platform);
}

export function filterLibraryGames(games: readonly LibraryGame[], filters: LibraryFilters): LibraryGame[] {
  const search = filters.search?.trim().toLocaleLowerCase() ?? "";
  const filtered = games.filter((game) => {
    if (filters.section === "favorites" && !game.favorite) return false;
    if (filters.section === "recent" && game.recentRank === null) return false;
    if (filters.section === "pins" && !game.pinned) return false;
    if (search && !game.name.toLocaleLowerCase().includes(search)) return false;
    return includesPlatform(filters.platforms, game.platform);
  });

  if (filters.section === "recent") {
    return filtered
      .map((game, index) => ({ game, index }))
      .sort((a, b) => (a.game.recentRank! - b.game.recentRank!) || (a.index - b.index))
      .map(({ game }) => game);
  }

  if (filters.section === "favorites") return filtered;

  return filtered
    .map((game, index) => ({ game, index }))
    .sort((a, b) => Number(b.game.pinned) - Number(a.game.pinned) || a.index - b.index)
    .map(({ game }) => game);
}
