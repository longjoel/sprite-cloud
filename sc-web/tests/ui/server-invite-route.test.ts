import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();

function source(path: string) {
  return readFileSync(join(root, path), "utf8");
}

describe("#608 server invite route", () => {
  it("passes every server membership's real role to the dashboard", () => {
    const page = source("app/servers/page.tsx");

    expect(page).toContain("role: serverMembers.role");
    expect(page).toContain("role: srv.role");
    expect(page).not.toContain('eq(serverMembers.role, "admin")');
  });
});
