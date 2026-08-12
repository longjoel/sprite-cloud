import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(__dirname, "..");
function read(relativePath: string): string {
  try {
    return readFileSync(path.join(root, relativePath), "utf8");
  } catch {
    return "";
  }
}

describe("#599 invite-only enrollment", () => {
  it("stores only hashed invite capabilities and durable redemption history", () => {
    const schema = read("lib/db/schema.ts");
    expect(schema).toMatch(/pgTable\(\s*"invite_codes"/);
    expect(schema).toContain('text("code_hash")');
    expect(schema).toMatch(/pgTable\(\s*"invite_redemptions"/);
    expect(schema).toContain('integer("max_redemptions")');
    expect(schema).toContain('timestamp("expires_at"');
    expect(schema).not.toContain('text("invite_code")');
  });

  it("authorizes invite management through exact server-admin membership", () => {
    const collection = read("app/api/servers/[server_id]/invites/route.ts");
    const item = read("app/api/servers/[server_id]/invites/[invite_id]/route.ts");
    expect(collection).toContain("requireServerAdmin");
    expect(item).toContain("requireServerAdmin");
    expect(collection).toContain("generateInviteCode");
    expect(collection).toContain("validCsrf");
    expect(collection).toContain("maxRedemptions > 100");
    expect(collection).not.toMatch(/codeHash\s*[:,]\s*invite\.codeHash/);
  });

  it("redeems atomically under a row lock and links the account to the server", () => {
    const route = read("app/api/invites/[code]/route.ts");
    const service = read("lib/invites.ts");
    expect(route).toContain("redeemInviteAccount");
    expect(route).toContain("checkRateLimit");
    expect(route).toContain("invite-redemption:");
    expect(service).toContain("database.transaction");
    expect(service).toMatch(/\.for\(["']update["']\)/);
    expect(service).toContain("inviteRedemptions");
    expect(service).toContain("serverMembers");
    expect(service).toContain("redemptionCount");
  });

  it("keeps open signup closed and exposes invite management in the server dashboard", () => {
    const signup = read("app/api/auth/signup/route.ts");
    const dashboard = read("app/servers/DashboardClient.tsx");
    const manager = read("app/servers/InviteManager.tsx");
    const nextConfig = read("next.config.ts");
    const middleware = read("middleware.ts");
    const instrumentation = read("instrumentation.ts");
    const setupRoute = read("app/api/auth/setup/route.ts");
    const setupPage = read("app/setup/page.tsx");
    expect(signup).toContain("status: 410");
    expect(setupRoute).toContain("status: 410");
    expect(setupPage).not.toContain("sc-setup-code");
    expect(setupPage).not.toContain("readFileSync");
    expect(instrumentation).toContain('kind: "bootstrap"');
    expect(instrumentation).toContain("/invite/${code");
    expect(instrumentation).toContain("mode: 0o600");
    expect(nextConfig).toContain('{ key: "Referrer-Policy", value: "no-referrer" }');
    expect(middleware).toContain('"/invite/:path*"');
    expect(dashboard).toContain('<InviteManager serverId={inviteTarget.id} canManage={inviteTarget.role === "admin"}');
    expect(dashboard).toContain('membership.role === "admin"');
    expect(dashboard).toContain('Manage ${membership.name}');
    expect(manager).toContain("canManage");
    expect(manager).toContain("disabled={!canManage");
    expect(manager).toContain("maxRedemptions");
    expect(manager).toContain("expiresInHours");
  });

  it("ships the reviewed invite migration through the deployment workflow", () => {
    const workflow = read("../.github/workflows/deploy.yml");
    const migration = read("drizzle/0018_add_invite_codes.sql");
    expect(workflow).toContain("sc-web/drizzle/0018_add_invite_codes.sql");
    expect(workflow.indexOf("Apply additive schema migrations")).toBeLessThan(
      workflow.indexOf("Restart sc-web on VPS"),
    );
    expect(migration).toContain("invite_codes_redemption_within_max");
    expect(migration).toContain("ON DELETE CASCADE");
  });
});
