import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("../../components/LibraryClient.tsx", import.meta.url), "utf8");

describe("Recent library rendering", () => {
  it("uses shared date and timestamp fallbacks", () => {
    expect(source).toContain("formatRecentGroupLabel");
    expect(source).toContain("formatRelativeAge(game.playedAt)");
    expect(source).not.toContain('game.playedAt ? formatRelativeAge(game.playedAt) : "—"');
  });

  it("renders recent games in a dedicated Recently Played metro group", () => {
    expect(source).toContain('"Recently Played"');
    expect(source).toContain("metroGroups");
  });
});
