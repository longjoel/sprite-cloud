import { describe, expect, it } from "vitest";
import {
  LIBRARY_SECTIONS,
  createAllLibraryPageParams,
  createLibraryFilters,
  createLibraryPageParams,
  createLatestRequestGate,
  filterLibraryGames,
  formatRecentGroupLabel,
  formatRelativeAge,
  getEmptyStateMessage,
  groupRecentGamesByLocalDate,
  mergeLibraryPages,
  mergeRecentLibraryPages,
  normalizeRecentGameIds,
  normalizeRecentGameIdsWithTimestamps,
  type LibraryGame,
} from "@/lib/ui/library-view-model";

const games: LibraryGame[] = [
  { id: "alpha", name: "Alpha Quest", platform: "NES", favorite: false, pinned: false, recentRank: null, serverId: "one", coverUrl: null },
  { id: "beta", name: "Beta Racing", platform: "SNES", favorite: true, pinned: true, recentRank: 2, serverId: "one", coverUrl: "/beta.png" },
  { id: "gamma", name: "Gamma World", platform: "NES", favorite: true, pinned: false, recentRank: 1, serverId: "two", coverUrl: null },
  { id: "delta", name: "Delta Force", platform: "Genesis", favorite: false, pinned: true, recentRank: null, serverId: "two", coverUrl: null },
];

const ids = (result: LibraryGame[]) => result.map((game) => game.id);

describe("library view model", () => {
  it("defines every library section in canonical order", () => {
    expect(LIBRARY_SECTIONS.map(({ id }) => id)).toEqual(["all", "favorites", "recent", "pins"]);
  });

  it.each([
    ["all", ["beta", "delta", "alpha", "gamma"]],
    ["favorites", ["beta", "gamma"]],
    ["recent", ["gamma", "beta"]],
    ["pins", ["beta", "delta"]],
  ] as const)("filters the %s section", (section, expected) => {
    expect(ids(filterLibraryGames(games, { section }))).toEqual(expected);
  });

  it.each(["all", "favorites", "recent", "pins"] as const)("applies search in the %s section", (section) => {
    expect(ids(filterLibraryGames(games, { section, search: "beta" }))).toEqual(["beta"]);
  });

  it("filters by selected platforms", () => {
    expect(ids(filterLibraryGames(games, { section: "all", platforms: new Set(["NES"]) }))).toEqual(["alpha", "gamma"]);
  });

  it("keeps original order stable within pinned and unpinned groups", () => {
    const reordered = [games[3], games[2], games[1], games[0]];
    expect(ids(filterLibraryGames(reordered, { section: "all" }))).toEqual(["delta", "beta", "gamma", "alpha"]);
  });

  it("preserves API order in Favorites instead of promoting pinned games", () => {
    expect(ids(filterLibraryGames([games[2], games[1]], { section: "favorites" }))).toEqual(["gamma", "beta"]);
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

  it("keeps every all-library page in pins-first offset semantics", () => {
    expect(createAllLibraryPageParams(100, 0, " mario ")).toEqual({
      limit: "100", offset: "0", search: "mario", pins_first: "true",
    });
    expect(createAllLibraryPageParams(100, 100, " mario ")).toEqual({
      limit: "100", offset: "100", search: "mario", pins_first: "true",
    });
  });

  it("does not count repeated pins as appended rows or skip the next offset", () => {
    const merged = mergeLibraryPages([games[1], games[0], games[2]], [games[1], games[3]]);
    expect(ids(merged)).toEqual(["beta", "alpha", "gamma", "delta"]);
    expect(createAllLibraryPageParams(3, merged.length, "").offset).toBe("4");
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
  it("uses text labels for Favorites, Recently Played, and Pinned sections", () => {
    expect(LIBRARY_SECTIONS.map(({ id, label }) => [id, label])).toEqual([
      ["all", "All"],
      ["favorites", "Favorites"],
      ["recent", "Recently Played"],
      ["pins", "Pinned"],
    ]);
  });
});

describe("empty state messages", () => {
  it("returns section-specific empty state messages", () => {
    expect(getEmptyStateMessage("all")).toBe("No games found");
    expect(getEmptyStateMessage("favorites")).toBe("No favorites yet");
    expect(getEmptyStateMessage("recent")).toBe("No recent plays");
    expect(getEmptyStateMessage("pins")).toBe("Nothing pinned yet");
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
