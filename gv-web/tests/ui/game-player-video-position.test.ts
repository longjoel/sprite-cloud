import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("../../components/GamePlayer.module.css", import.meta.url), "utf8");

describe("GamePlayer video positioning", () => {
  it("keeps landscape centered and top-aligns video only in portrait", () => {
    const baseVideoRule = css.match(/\.video\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(baseVideoRule).not.toContain("object-position: top center");
    expect(css).toMatch(/@media\s*\(orientation:\s*portrait\)[\s\S]*?\.video\s*\{[^}]*object-position:\s*top center/);
  });
});
