import { describe, expect, it } from "vitest";
import {
  LIBRARY_SECTIONS,
  createLibraryFilters,
  createLibraryPageParams,
  createLatestRequestGate,
  filterLibraryGames,
  normalizeRecentGameIds,
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

  it("builds paginated section params with the debounced server search convention", () => {
    expect(createLibraryPageParams(100, 50, "  mario  ")).toEqual({
      limit: "100",
      offset: "50",
      search: "mario",
    });
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
