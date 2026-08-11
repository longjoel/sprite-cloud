import { describe, expect, it } from "vitest";
import { pickFeatured, slugify, type WallGame } from "@/lib/wall-shared";

function game(overrides: Partial<WallGame>): WallGame {
  return {
    id: "g",
    name: "Game",
    platform: "Arcade",
    maxPlayers: 2,
    coverUrl: "/api/covers/s/g",
    serverId: "s",
    serverName: "server",
    serverOnline: true,
    live: true,
    players: 0,
    viewers: 0,
    maxSeats: 2,
    freePlay: false,
    alwaysOn: false,
    slug: "game",
    watchUrl: "/watch/game",
    roomUrl: "/r/tok?game_id=g&server_id=s",
    key: "s:g",
    ...overrides,
  };
}

describe("slugify (#781 watch links)", () => {
  it("lowercases and replaces spaces with hyphens", () => {
    expect(slugify("Balloon Fight")).toBe("balloon-fight");
    expect(slugify("Metal Slug")).toBe("metal-slug");
  });

  it("strips punctuation and collapses separators", () => {
    expect(slugify("Sonic the Hedgehog 2 (USA)")).toBe("sonic-the-hedgehog-2-usa");
    expect(slugify("Donkey Kong Jr.")).toBe("donkey-kong-jr");
  });

  it("handles empty / symbol-only names safely", () => {
    expect(slugify("")).toBe("");
    expect(slugify("!!!")).toBe("");
  });

  it("caps length for URL sanity", () => {
    const long = "x".repeat(200);
    expect(slugify(long).length).toBeLessThanOrEqual(64);
  });
});

describe("pickFeatured (#781 hero rotation)", () => {
  const balloon = game({ id: "b", name: "Balloon", slug: "balloon", key: "s:b", alwaysOn: true, watchUrl: "/watch/balloon" });
  const mslug = game({ id: "m", name: "MSlug", slug: "mslug", key: "s:m", watchUrl: "/watch/mslug" });
  const idle = game({ id: "t", name: "Tetris", slug: "tetris", key: "s:t", live: false, roomUrl: undefined });

  it("returns null when nothing is live", () => {
    expect(pickFeatured([idle], null)).toBeNull();
    expect(pickFeatured([], null)).toBeNull();
  });

  it("prefers an always-on resident on first pick", () => {
    expect(pickFeatured([mslug, balloon], null)?.key).toBe("s:b");
  });

  it("round-robins to the next live game after the current key", () => {
    expect(pickFeatured([balloon, mslug], "s:b")?.key).toBe("s:m");
    expect(pickFeatured([balloon, mslug], "s:m")?.key).toBe("s:b");
  });

  it("wraps around and skips non-live games", () => {
    // balloon -> mslug -> (tetris skipped) -> balloon
    expect(pickFeatured([balloon, mslug, idle], "s:m")?.key).toBe("s:b");
  });

  it("falls back to first live game when current key is unknown", () => {
    expect(pickFeatured([mslug, balloon], "s:unknown")?.key).toBe("s:b");
  });
});
