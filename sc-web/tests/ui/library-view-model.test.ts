import { describe, expect, it } from "vitest";
import {
  LIBRARY_SECTIONS,

  createLibraryFilters,
  createLibraryPageParams,
  createLatestRequestGate,
  createPlayableHostsParams,
  filterLibraryGames,
  formatRecentGroupLabel,
  formatRelativeAge,
  getEmptyStateMessage,
  groupRecentGamesByLocalDate,
  isSavedGameFavorite,
  isServerLocalGame,
  libraryGameKey,
  mergeLibraryPages,
  mergeLegacySavedGameIds,
  mergeRecentLibraryPages,
  migrateLegacyPinsToFavorites,
  normalizeRecentGameIds,
  normalizeRecentGameIdsWithTimestamps,
  toggleSavedGameFavorite,

  type LibraryGame,
} from "@/lib/ui/library-view-model";

const games: LibraryGame[] = [
  { id: "alpha", name: "Alpha Quest", platform: "NES", favorite: false, recentRank: null, serverId: "one", coverUrl: null },
  { id: "beta", name: "Beta Racing", platform: "SNES", favorite: true, recentRank: 2, serverId: "one", coverUrl: "/beta.png" },
  { id: "gamma", name: "Gamma World", platform: "NES", favorite: true, recentRank: 1, serverId: "two", coverUrl: null },
  { id: "delta", name: "Delta Force", platform: "Genesis", favorite: false, recentRank: null, serverId: "two", coverUrl: null },
];

const ids = (result: LibraryGame[]) => result.map((game) => game.id);

describe("library view model", () => {
  it("distinguishes opaque server-local IDs from legacy cloud games with server IDs", () => {
    expect(isServerLocalGame({ id: "local_0123456789abcdef0123456789abcdef" })).toBe(true);
    expect(isServerLocalGame({ id: "550e8400-e29b-41d4-a716-446655440000" })).toBe(false);
  });


  it("defines every library section in canonical order", () => {
    expect(LIBRARY_SECTIONS.map(({ id }) => id)).toEqual(["all", "favorites", "recent"]);
  });

  it.each([
    ["all", ["alpha", "beta", "gamma", "delta"]],
    ["favorites", ["beta", "gamma"]],
    ["recent", ["gamma", "beta"]],

  ] as const)("filters the %s section", (section, expected) => {
    expect(ids(filterLibraryGames(games, { section }))).toEqual(expected);
  });

  it.each(["all", "favorites", "recent"] as const)("applies search in the %s section", (section) => {
    expect(ids(filterLibraryGames(games, { section, search: "beta" }))).toEqual(["beta"]);
  });

  it("filters by selected platforms", () => {
    expect(ids(filterLibraryGames(games, { section: "all", platforms: new Set(["NES"]) }))).toEqual(["alpha", "gamma"]);
  });

  it("keeps the server's original order in All", () => {
    const reordered = [games[3], games[2], games[1], games[0]];
    expect(ids(filterLibraryGames(reordered, { section: "all" }))).toEqual(["delta", "gamma", "beta", "alpha"]);
  });

  it("preserves API order in Favorites", () => {
    expect(ids(filterLibraryGames([games[2], games[1]], { section: "favorites" }))).toEqual(["gamma", "beta"]);
  });

  it("migrates valid legacy pins into Favorites without duplicates", () => {
    expect([...mergeLegacySavedGameIds(new Set(["alpha"]), '["alpha","beta",42]')]).toEqual(["alpha", "beta"]);
    expect([...mergeLegacySavedGameIds(new Set(["alpha"]), "not json")]).toEqual(["alpha"]);
  });

  it("keeps legacy pins when persisting migrated Favorites fails", () => {
    let pinsRemoved = false;
    const storage = {
      getItem: (key: string) => key === "favorites" ? '["alpha"]' : '["beta"]',
      setItem: () => { throw new Error("storage denied"); },
      removeItem: () => { pinsRemoved = true; },
    };

    expect(() => migrateLegacyPinsToFavorites(storage, "favorites", "pins")).toThrow("storage denied");
    expect(pinsRemoved).toBe(false);
  });

  it("removes legacy pins only after Favorites are persisted", () => {
    const calls: string[] = [];
    const storage = {
      getItem: (key: string) => key === "favorites" ? '["alpha"]' : '["beta"]',
      setItem: (_key: string, value: string) => calls.push(`set:${value}`),
      removeItem: (key: string) => calls.push(`remove:${key}`),
    };

    expect([...migrateLegacyPinsToFavorites(storage, "favorites", "pins")]).toEqual(["alpha", "beta"]);
    expect(calls).toEqual(['set:["alpha","beta"]', "remove:pins"]);
  });

  it("does not rewrite Favorites after legacy pins have already been removed", () => {
    const calls: string[] = [];
    const storage = {
      getItem: (key: string) => key === "favorites" ? '["alpha"]' : null,
      setItem: () => calls.push("set"),
      removeItem: () => calls.push("remove"),
    };

    expect([...migrateLegacyPinsToFavorites(storage, "favorites", "pins")]).toEqual(["alpha"]);
    expect(calls).toEqual([]);
  });

  it.each(["all", "favorites", "recent"] as const)("forwards search from the %s consumer adapter", (section) => {
    const filters = createLibraryFilters(section, "beta", new Set<string>());
    expect(ids(filterLibraryGames(games, filters))).toEqual(["beta"]);
  });

  it("normalizes recent IDs and ranks from the recent-plays games response", () => {
    const response = { games: [{ id: "gamma" }, { id: "beta" }], total: 2 };
    expect(normalizeRecentGameIds(response)).toEqual(["gamma", "beta"]);
  });

  it("de-duplicates and sorts recent games newest-first before grouping by local date", () => {
    const result = groupRecentGamesByLocalDate([
      { id: "older", playedAt: "2026-07-10T20:00:00.000Z" },
      { id: "same-b", playedAt: "2026-07-11T10:00:00.000Z" },
      { id: "older", playedAt: "2026-07-11T09:00:00.000Z" },
      { id: "same-a", playedAt: "2026-07-11T10:00:00.000Z" },
    ], "UTC");
    expect(result.map((group) => [group.date, group.games.map((game) => game.id)])).toEqual([
      ["2026-07-11", ["same-a", "same-b", "older"]],
    ]);
  });

  it("groups recent games using local calendar dates with YYYY-MM-DD labels", () => {
    const result = groupRecentGamesByLocalDate([
      { id: "after-midnight", playedAt: "2026-07-11T00:30:00.000Z" },
      { id: "before-midnight", playedAt: "2026-07-10T23:30:00.000Z" },
    ], "America/New_York");
    expect(result.map((group) => group.date)).toEqual(["2026-07-10"]);
  });

  it("prefixes today's and yesterday's local date headings without dropping the date", () => {
    const now = new Date("2026-07-11T04:30:00.000Z");
    expect(formatRecentGroupLabel("2026-07-11", now, "America/New_York")).toBe("Today — 2026-07-11");
    expect(formatRecentGroupLabel("2026-07-10", now, "America/New_York")).toBe("Yesterday — 2026-07-10");
    expect(formatRecentGroupLabel("2026-07-09", now, "America/New_York")).toBe("2026-07-09");
    expect(formatRecentGroupLabel("unknown", now, "America/New_York")).toBe("Unknown date");
  });

  it("keeps missing and invalid timestamps visible in an Unknown date group", () => {
    const result = groupRecentGamesByLocalDate([
      { id: "valid", playedAt: "2026-07-11T10:00:00.000Z" },
      { id: "missing" },
      { id: "invalid", playedAt: "not-a-date" },
    ], "UTC");
    expect(result.map((group) => [group.date, group.games.map((game) => game.id)])).toEqual([
      ["2026-07-11", ["valid"]],
      ["unknown", ["invalid", "missing"]],
    ]);
    expect(formatRelativeAge(undefined)).toBe("time unavailable");
    expect(formatRelativeAge("not-a-date")).toBe("time unavailable");
  });

  it("merges recent pages by retaining the newest valid timestamp per ID", () => {
    const current = [
      { id: "newer-incoming", playedAt: "2026-07-10T10:00:00.000Z" },
      { id: "older-incoming", playedAt: "2026-07-11T10:00:00.000Z" },
      { id: "valid-beats-invalid", playedAt: "2026-07-09T10:00:00.000Z" },
      { id: "invalid-replaced", playedAt: "bad" },
    ];
    const incoming = [
      { id: "newer-incoming", playedAt: "2026-07-12T10:00:00.000Z" },
      { id: "older-incoming", playedAt: "2026-07-08T10:00:00.000Z" },
      { id: "valid-beats-invalid", playedAt: "bad" },
      { id: "invalid-replaced", playedAt: "2026-07-07T10:00:00.000Z" },
    ];
    const merged = mergeRecentLibraryPages(current, incoming);
    expect(merged.map((game) => [game.id, game.playedAt])).toEqual([
      ["newer-incoming", "2026-07-12T10:00:00.000Z"],
      ["older-incoming", "2026-07-11T10:00:00.000Z"],
      ["valid-beats-invalid", "2026-07-09T10:00:00.000Z"],
      ["invalid-replaced", "2026-07-07T10:00:00.000Z"],
    ]);
  });

  it("formats compact relative ages", () => {
    const now = new Date("2026-07-11T12:00:00.000Z");
    expect(formatRelativeAge("2026-07-11T11:59:40.000Z", now)).toBe("now");
    expect(formatRelativeAge("2026-07-11T07:00:00.000Z", now)).toBe("5h ago");
    expect(formatRelativeAge("2026-07-08T12:00:00.000Z", now)).toBe("3d ago");
  });

  it("builds paginated section params with the debounced server search convention", () => {
    expect(createLibraryPageParams(100, 50, "  mario  ")).toEqual({
      limit: "100",
      offset: "50",
      search: "mario",
    });
  });


  it("namespaces playable-host lookup for server-owned games", () => {
    expect(createPlayableHostsParams({ id: "local_abc", serverId: "server-a" })).toEqual({
      game_id: "local_abc",
      server_id: "server-a",
    });
    expect(createPlayableHostsParams({ id: "legacy", serverId: null })).toEqual({ game_id: "legacy" });
  });

  it("does not collapse matching local IDs from different servers", () => {
    const first = { ...games[0], id: "local_same", serverId: "server-a" };
    const second = { ...games[0], id: "local_same", serverId: "server-b" };

    expect(libraryGameKey(first)).toBe("server-a:local_same");
    expect(mergeLibraryPages([first], [second]).map(libraryGameKey)).toEqual([
      "server-a:local_same",
      "server-b:local_same",
    ]);
  });

  it("keeps Favorites independent for matching game IDs on different servers", () => {
    const first = { ...games[0], id: "local_same", serverId: "server-a" };
    const second = { ...games[0], id: "local_same", serverId: "server-b" };
    const favorites = toggleSavedGameFavorite(new Set(), first);

    expect(isSavedGameFavorite(favorites, first)).toBe(true);
    expect(isSavedGameFavorite(favorites, second)).toBe(false);
    expect([...favorites]).toEqual(["server-a:local_same"]);
  });

  it("recognizes and safely clears legacy bare-ID Favorites", () => {
    const first = { ...games[0], id: "local_same", serverId: "server-a" };
    const second = { ...games[0], id: "local_same", serverId: "server-b" };
    const legacyFavorites = new Set(["local_same"]);

    expect(isSavedGameFavorite(legacyFavorites, first)).toBe(true);
    expect(isSavedGameFavorite(legacyFavorites, second)).toBe(true);
    expect([...toggleSavedGameFavorite(legacyFavorites, first)]).toEqual([]);
    expect([...toggleSavedGameFavorite(new Set(["local_same", "server-a:local_same"]), first)]).toEqual([]);
  });

  it("does not count repeated games as appended rows or skip the next offset", () => {
    const merged = mergeLibraryPages([games[1], games[0], games[2]], [games[1], games[3]]);
    expect(ids(merged)).toEqual(["beta", "alpha", "gamma", "delta"]);
    expect(createLibraryPageParams(3, merged.length, "").offset).toBe("4");
  });

  it("accepts only the latest reset response when searches resolve out of order", () => {
    const gate = createLatestRequestGate();
    const first = gate.beginReset();
    const latest = gate.beginReset();

    expect(gate.isCurrent(latest)).toBe(true);
    expect(gate.isCurrent(first)).toBe(false);
  });

  it("keeps pagination in the current reset generation", () => {
    const gate = createLatestRequestGate();
    const reset = gate.beginReset();
    const page = gate.current();

    expect(page).toBe(reset);
    expect(gate.isCurrent(page)).toBe(true);
    gate.beginReset();
    expect(gate.isCurrent(page)).toBe(false);
  });
});

describe("canonical library labels", () => {
  it("uses text labels for the three distinct library sections", () => {
    expect(LIBRARY_SECTIONS.map(({ id, label }) => [id, label])).toEqual([
      ["all", "All"],
      ["favorites", "Favorites"],
      ["recent", "Recently Played"],

    ]);
  });
});

describe("empty state messages", () => {
  it("returns section-specific empty state messages", () => {
    expect(getEmptyStateMessage("all")).toBe("No games found");
    expect(getEmptyStateMessage("favorites")).toBe("No favorites yet");
    expect(getEmptyStateMessage("recent")).toBe("No recent plays");

  });
});

describe("normalizeRecentGameIdsWithTimestamps", () => {
  it("preserves playedAt timestamps and maintains server response order", () => {
    const response = {
      games: [
        { id: "gamma", playedAt: "2026-07-13T10:00:00.000Z" },
        { id: "beta", playedAt: "2026-07-12T08:00:00.000Z" },
      ],
      total: 2,
    };
    const result = normalizeRecentGameIdsWithTimestamps(response);
    expect(result).toEqual([
      { id: "gamma", playedAt: "2026-07-13T10:00:00.000Z" },
      { id: "beta", playedAt: "2026-07-12T08:00:00.000Z" },
    ]);
  });

  it("returns empty array for missing or invalid responses", () => {
    expect(normalizeRecentGameIdsWithTimestamps(null)).toEqual([]);
    expect(normalizeRecentGameIdsWithTimestamps({})).toEqual([]);
    expect(normalizeRecentGameIdsWithTimestamps({ games: "not-an-array" })).toEqual([]);
  });

  it("returns empty array for games without ids", () => {
    expect(normalizeRecentGameIdsWithTimestamps({ games: [{ playedAt: "2026-07-13T10:00:00.000Z" }] })).toEqual([]);
  });
});
