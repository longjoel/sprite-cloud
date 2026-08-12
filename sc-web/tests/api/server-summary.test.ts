import { beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.fn();
const select = vi.fn();

vi.mock("@/lib/auth", () => ({ auth }));
vi.mock("@/lib/db", () => ({ db: { select } }));

function query(rows: unknown[]) {
  const chain: Record<string, ReturnType<typeof vi.fn>> = {
    from: vi.fn().mockReturnThis(),
    innerJoin: vi.fn().mockReturnThis(),
    leftJoin: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    groupBy: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
  };
  return Object.assign(Promise.resolve(rows), chain);
}

describe("GET /api/servers/summary", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    auth.mockResolvedValue({ user: { id: "user-1" } });
  });

  it("requires authentication", async () => {
    auth.mockResolvedValue(null);
    const { GET } = await import("@/app/api/servers/summary/route");
    expect((await GET()).status).toBe(401);
  });

  it("returns membership-scoped operational summaries with counts and active upgrades", async () => {
    const recent = new Date();
    select
      .mockReturnValueOnce(query([
        {
          serverId: "server-1",
          role: "admin",
          lastSeenAt: recent,
          metadata: { version: "0.11.3", lan: { health_urls: ["http://host:8787/health"] } },
        },
      ]))
      .mockReturnValueOnce(query([{ serverId: "server-1", count: 426 }]))
      .mockReturnValueOnce(query([{ serverId: "server-1", count: 2 }]))
      .mockReturnValueOnce(query([{ serverId: "server-1", commandId: "upgrade-1", status: "leased" }]));

    const { GET } = await import("@/app/api/servers/summary/route");
    const response = await GET();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      servers: [{
        serverId: "server-1",
        role: "admin",
        health: "online",
        lastSeenAt: recent.toISOString(),
        installedVersion: "0.11.3",
        activeSessionCount: 2,
        gameCount: 426,
        lan: { configured: true, healthUrls: ["http://host:8787/health"] },
        activeUpgrade: { commandId: "upgrade-1", status: "leased" },
      }],
    });
  });

  it("does not query server-owned data when the user has no memberships", async () => {
    select.mockReturnValueOnce(query([]));
    const { GET } = await import("@/app/api/servers/summary/route");
    const response = await GET();

    expect(await response.json()).toEqual({ servers: [] });
    expect(select).toHaveBeenCalledTimes(1);
  });

  it("redacts active upgrade command handles from ordinary members", async () => {
    select
      .mockReturnValueOnce(query([{
        serverId: "server-1",
        role: "member",
        lastSeenAt: new Date(),
        metadata: {},
      }]))
      .mockReturnValueOnce(query([]))
      .mockReturnValueOnce(query([]))
      .mockReturnValueOnce(query([{
        serverId: "server-1",
        commandId: "internal-upgrade-command",
        status: "leased",
      }]));

    const { GET } = await import("@/app/api/servers/summary/route");
    const body = await (await GET()).json();

    expect(body.servers[0].activeUpgrade).toBeNull();
    expect(JSON.stringify(body)).not.toContain("internal-upgrade-command");
  });
});
