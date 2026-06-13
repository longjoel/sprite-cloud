import { describe, it, expect } from "vitest";
import { generateCode } from "@/lib/pairing";

describe("pairing", () => {
  it("generates 8 uppercase letters", () => {
    const code = generateCode();
    expect(code).toHaveLength(8);
    expect(code).toMatch(/^[A-Z]{8}$/);
  });

  it("generates unique codes", () => {
    const codes = new Set(Array.from({ length: 100 }, generateCode));
    expect(codes.size).toBeGreaterThan(90);
  });
});
