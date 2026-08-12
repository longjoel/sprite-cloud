import { describe, expect, it } from "vitest";
import nextConfig from "../../next.config";

describe("cover upload preview CSP", () => {
  it("allows local blob image previews without allowing external image origins", async () => {
    const rules = await nextConfig.headers!();
    const globalRule = rules.find((rule) => rule.source === "/:path((?!embed).*)");
    const csp = globalRule?.headers.find((header) => header.key === "Content-Security-Policy")?.value;

    expect(csp).toContain("img-src 'self' data: blob:");
    expect(csp).not.toMatch(/img-src[^;]*https?:/);
  });
});