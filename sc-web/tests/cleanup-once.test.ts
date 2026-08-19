import { describe, it, expect, vi } from "vitest";
import { cleanupOnce } from "@/lib/db/cleanup";

describe("cleanupOnce error handling", () => {
  it("rejects when the database cleanup query fails", async () => {
    const failingDb: any = {
      transaction: vi.fn(async () => {
        throw new Error("boom");
      }),
    };

    await expect(cleanupOnce(failingDb as any)).rejects.toThrow("boom");
  });
});
