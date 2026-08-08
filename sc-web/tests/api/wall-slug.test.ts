import { describe, expect, it } from "vitest";
import { slugify } from "@/lib/wall";

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
