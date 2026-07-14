export type LibrarySection = "all" | "favorites" | "recent" | "pins";

export interface LibrarySectionMetadata {
  id: LibrarySection;
  label: string;
}

export const LIBRARY_SECTIONS: readonly LibrarySectionMetadata[] = [
  { id: "all", label: "All" },
  { id: "favorites", label: "Favorites" },
  { id: "recent", label: "Recently Played" },
  { id: "pins", label: "Pinned" },
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

export function createAllLibraryPageParams(pageSize: number, offset: number, search: string): Record<string, string> {
  return { ...createLibraryPageParams(pageSize, offset, search), pins_first: "true" };
}

export function mergeLibraryPages<T extends { id: string }>(current: readonly T[], next: readonly T[]): T[] {
  const seen = new Set(current.map((game) => game.id));
  return [...current, ...next.filter((game) => !seen.has(game.id))];
}

export interface RecentGameLike { id: string; playedAt?: string | null; }
export type RecentDateKey = string | "unknown";
export interface RecentDateGroup<T extends RecentGameLike> { date: RecentDateKey; games: T[]; }

function timestampMillis(value: string | null | undefined): number | null {
  if (!value) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function localDateKey(value: string | Date, timeZone?: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(typeof value === "string" ? new Date(value) : value);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

export function formatRecentGroupLabel(date: RecentDateKey, now = new Date(), timeZone?: string): string {
  if (date === "unknown") return "Unknown date";
  const today = localDateKey(now, timeZone);
  if (date === today) return `Today — ${date}`;
  const yesterday = new Date(`${today}T00:00:00.000Z`);
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  if (date === yesterday.toISOString().slice(0, 10)) return `Yesterday — ${date}`;
  return date;
}

function preferNewest<T extends RecentGameLike>(previous: T | undefined, candidate: T): T {
  if (!previous) return candidate;
  const previousTime = timestampMillis(previous.playedAt);
  const candidateTime = timestampMillis(candidate.playedAt);
  if (candidateTime !== null && (previousTime === null || candidateTime > previousTime)) return candidate;
  return previous;
}

function sortRecentGames<T extends RecentGameLike>(games: readonly T[]): T[] {
  return [...games].sort((a, b) => {
    const aTime = timestampMillis(a.playedAt);
    const bTime = timestampMillis(b.playedAt);
    if (aTime === null && bTime === null) return a.id.localeCompare(b.id);
    if (aTime === null) return 1;
    if (bTime === null) return -1;
    return bTime - aTime || a.id.localeCompare(b.id);
  });
}

export function mergeRecentLibraryPages<T extends RecentGameLike>(current: readonly T[], incoming: readonly T[]): T[] {
  const latestById = new Map<string, T>();
  for (const game of [...current, ...incoming]) {
    latestById.set(game.id, preferNewest(latestById.get(game.id), game));
  }
  return sortRecentGames([...latestById.values()]);
}

export function groupRecentGamesByLocalDate<T extends RecentGameLike>(games: readonly T[], timeZone?: string): RecentDateGroup<T>[] {
  const sorted = mergeRecentLibraryPages([], games);
  const groups: RecentDateGroup<T>[] = [];
  for (const game of sorted) {
    const date: RecentDateKey = timestampMillis(game.playedAt) === null ? "unknown" : localDateKey(game.playedAt!, timeZone);
    const last = groups.at(-1);
    if (last?.date === date) last.games.push(game);
    else groups.push({ date, games: [game] });
  }
  return groups;
}

export function formatRelativeAge(playedAt: string | null | undefined, now = new Date()): string {
  const timestamp = timestampMillis(playedAt);
  if (timestamp === null) return "time unavailable";
  const seconds = Math.max(0, Math.floor((now.getTime() - timestamp) / 1000));
  if (seconds < 60) return "now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  if (seconds < 86400 * 30) return `${Math.floor(seconds / 86400)}d ago`;
  if (seconds < 86400 * 365) return `${Math.floor(seconds / (86400 * 30))}mo ago`;
  return `${Math.floor(seconds / (86400 * 365))}y ago`;
}

export function normalizeRecentGameIds(response: unknown): string[] {
  if (!response || typeof response !== "object" || !("games" in response) || !Array.isArray(response.games)) return [];
  return response.games
    .map((game) => game && typeof game === "object" && "id" in game ? game.id : null)
    .filter((id): id is string => typeof id === "string");
}

export interface RecentGameWithTimestamp {
  id: string;
  playedAt: string;
}

export function normalizeRecentGameIdsWithTimestamps(response: unknown): RecentGameWithTimestamp[] {
  if (!response || typeof response !== "object" || !("games" in response) || !Array.isArray(response.games)) return [];
  return response.games
    .filter((game): game is Record<string, unknown> => game !== null && typeof game === "object")
    .map((game) => game as Record<string, unknown>)
    .filter((game) => typeof game.id === "string")
    .map((game) => ({
      id: game.id as string,
      playedAt: typeof game.playedAt === "string" ? game.playedAt as string : "",
    }));
}

const EMPTY_STATE_MESSAGES: Record<LibrarySection, string> = {
  all: "No games found",
  favorites: "No favorites yet",
  recent: "No recent plays",
  pins: "Nothing pinned yet",
};

export function getEmptyStateMessage(section: LibrarySection): string {
  return EMPTY_STATE_MESSAGES[section] ?? "No games found";
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
