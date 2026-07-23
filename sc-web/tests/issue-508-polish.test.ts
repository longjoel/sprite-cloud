import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(__dirname, "..");

function read(relPath: string) {
  return readFileSync(path.join(root, relPath), "utf8");
}

describe("#508 polish regressions", () => {
  it("wraps /signin in a server redirect guard for signed-in users", () => {
    const source = read("app/signin/page.tsx");
    expect(source).not.toContain('"use client"');
    expect(source).toMatch(/auth\(/);
    expect(source).toMatch(/redirect\("\/xmb"\)/);
  });

  it("adds loading boundaries for app, dashboard, settings, and server settings", () => {
    for (const rel of [
      "app/loading.tsx",
      "app/dashboard/loading.tsx",
      "app/settings/loading.tsx",
      "app/settings/[server_id]/loading.tsx",
    ]) {
      expect(existsSync(path.join(root, rel)), `${rel} should exist`).toBe(true);
    }
  });

  it("wires app error UI to a retry action", () => {
    const source = read("app/error.tsx");
    expect(source).toContain("Retry");
    expect(source).toMatch(/reset\(/);
  });

  it("removes GitHub auth env handling from sc-web auth and local compose config", () => {
    const source = read("lib/auth.ts");
    const compose = read("../docker-compose.yml");
    expect(source).not.toContain("AUTH_GITHUB_ID");
    expect(source).not.toContain("AUTH_GITHUB_SECRET");
    expect(source).not.toContain('from "next-auth/providers/github"');
    expect(source).not.toContain('provider === "github"');
    expect(compose).not.toContain("AUTH_GITHUB_ID");
    expect(compose).not.toContain("AUTH_GITHUB_SECRET");
  });
});
