import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const read = (path: string) => readFileSync(join(root, path), "utf8");

describe("issue #610 enrolled member session launches", () => {
  it("deploys the additive short-code ownership migration before restarting sc-web", () => {
    const workflow = read("../.github/workflows/deploy.yml");
    const migration = read("drizzle/0019_bind_short_codes_to_users.sql");

    expect(workflow).toContain("sc-web/drizzle/0019_bind_short_codes_to_users.sql");
    expect(workflow.indexOf("0019_bind_short_codes_to_users.sql")).toBeLessThan(
      workflow.indexOf("Restart sc-web on VPS"),
    );
    expect(migration).toContain("ADD COLUMN IF NOT EXISTS created_by uuid");
    expect(migration).toContain("ON DELETE SET NULL");
  });

  it("binds host codes to creators without weakening invitation administration", () => {
    const schema = read("lib/db/schema.ts");
    const resolver = read("app/api/room/resolve/[code]/route.ts");
    const inviteApi = read("app/api/servers/[server_id]/invites/route.ts");
    const dashboard = read("app/servers/DashboardClient.tsx");
    const serverPanel = read("app/servers/ServerPanel.tsx");

    expect(schema).toContain('createdBy: uuid("created_by")');
    expect(resolver).toContain("entry.createdBy === browserSession.user.id");
    expect(inviteApi).toContain("requireServerAdmin");
    expect(dashboard).toContain('const isAdmin = membership.role === "admin"');
    expect(dashboard).toContain("isAdmin && (");
    expect(serverPanel).toContain("headers: csrfHeaders()");
  });
});
