import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("../../components/LibraryClient.tsx", import.meta.url), "utf8");

describe("Recent library rendering", () => {
  it("uses shared date and timestamp fallbacks in both views", () => {
    expect(source).toContain("formatRecentGroupLabel(group.date)");
    expect(source).toContain("formatRelativeAge(game.playedAt)");
    expect(source).not.toContain('game.playedAt ? formatRelativeAge(game.playedAt) : "—"');
  });

  it("marks table date headings as row-group headers", () => {
    expect(source).toMatch(/<th scope="rowgroup" colSpan=\{5\}/);
  });
});
