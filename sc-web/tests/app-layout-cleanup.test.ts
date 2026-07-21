import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

describe("app/layout cleanup startup", () => {
  it("does not import the cleanup module as a layout side effect", () => {
    const layoutPath = path.resolve(__dirname, "../app/layout.tsx");
    const source = readFileSync(layoutPath, "utf8");
    expect(source).not.toMatch(/import\s+["']@\/lib\/db\/cleanup["'];?/);
  });
});
