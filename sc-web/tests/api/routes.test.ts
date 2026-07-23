/**
 * sc-web API route tests.
 *
 * Tests every API route handler in isolation by importing the handler
 * functions directly and calling them with mock Requests.  DB and auth
 * are mocked so no Postgres instance is required.
 *
 * Run: npx vitest run tests/api/
 */

import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import { NextRequest } from "next/server";

const mockWebVersionEnv = {
  GV_WEB_VERSION: "0.1.0",
  GV_WEB_GIT_SHA: "web-sha-123",
  GV_WEB_RELEASED_AT_UTC: "2026-06-22T13:20:39Z",
};

// ── Mocks (must come before imports) ──────────────────────────────────

const mockDb = {
  select: vi.fn(),
  selectDistinct: vi.fn(),
  insert: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
  transaction: vi.fn(),
  execute: vi.fn(),
};

// Chainable query builder mocks
function mockQueryBuilder(returnValue: unknown) {
  const builder: Record<string, Mock> = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    innerJoin: vi.fn().mockReturnThis(),
    leftJoin: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    offset: vi.fn().mockReturnThis(),
    groupBy: vi.fn().mockReturnThis(),
    returning: vi.fn().mockReturnThis(),
    values: vi.fn().mockReturnThis(),
    set: vi.fn().mockReturnThis(),
    for: vi.fn().mockReturnThis(),
  };
  const thenable = Promise.resolve(returnValue);
  return Object.assign(thenable, builder);
}

// Make db methods return chainable builders
Object.assign(mockDb, {
  select: vi.fn(() => mockQueryBuilder([])),
  selectDistinct: vi.fn(() => mockQueryBuilder([])),
  insert: vi.fn(() => mockQueryBuilder([{ id: "test-id" }])),
  update: vi.fn(() => mockQueryBuilder(undefined)),
  delete: vi.fn(() => mockQueryBuilder(undefined)),
  transaction: vi.fn((fn: (tx: unknown) => unknown) => fn(mockDb as any)),
});

vi.mock("@/lib/db", () => ({ db: mockDb }));

// Auth mock — returns a session by default (signed-in user)
const mockAuth = vi.fn();
vi.mock("@/lib/auth", () => ({ auth: mockAuth }));

// Server auth mocks
const mockVerifyBearerToken = vi.fn();
const mockVerifyAdminToken = vi.fn();
const mockGeneratePairingCode = vi.fn(() => "ABCD-EFGH");
const mockPairingCodeExpiresAt = vi.fn(() => new Date(Date.now() + 300_000));
const mockGenerateApiKey = vi.fn(() => "scsk_test_api_key_12345");
const mockHashApiKey = vi.fn(() => "hashed_key");
const mockUnauthorizedResponse = vi.fn(() =>
  Response.json({ error: "unauthorized" }, { status: 401 }),
);

vi.mock("@/lib/server-auth", () => ({
  verifyBearerToken: mockVerifyBearerToken,
  verifyAdminToken: mockVerifyAdminToken,
  generatePairingCode: mockGeneratePairingCode,
  pairingCodeExpiresAt: mockPairingCodeExpiresAt,
  generateApiKey: mockGenerateApiKey,
  hashApiKey: mockHashApiKey,
  unauthorizedResponse: mockUnauthorizedResponse,
}));

const mockWaitForSdpAnswer = vi.fn();
vi.mock("@/lib/pending-sdp", () => ({ waitForSdpAnswer: mockWaitForSdpAnswer }));

// ── Helpers ────────────────────────────────────────────────────────────

function authHeader(token = "scsk_test_api_key_12345") {
  return { authorization: `Bearer ${token}` };
}

function jsonBody(body: unknown) {
  return {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

function jsonBodyWithCsrf(body: unknown, csrf = "csrf-test-token") {
  return {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-csrf-token": csrf,
      cookie: `sc_csrf_token=${csrf}`,
    },
    body: JSON.stringify(body),
  };
}

/** Build a Request-like object with nextUrl for Next.js App Router handlers. */
function mkReq(url: string, init?: RequestInit): NextRequest {
  const u = new URL(url);
  const req = new Request(url, init);
  return Object.assign(req, { nextUrl: u }) as unknown as NextRequest;
}

function collectQueryValues(value: unknown, seen = new Set<object>()): string[] {
  if (typeof value === "string") return [value];
  if (value === null || typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);
  if (Array.isArray(value)) return value.flatMap((item) => collectQueryValues(item, seen));
  return Object.values(value).flatMap((item) => collectQueryValues(item, seen));
}

function resetAllMocks() {
  vi.clearAllMocks();
  mockDb.select.mockReset().mockImplementation(() => mockQueryBuilder([]));
  mockDb.selectDistinct.mockReset().mockImplementation(() => mockQueryBuilder([]));
  mockDb.insert.mockReset().mockImplementation(() => mockQueryBuilder([{ id: "test-id" }]));
  mockDb.update.mockReset().mockImplementation(() => mockQueryBuilder(undefined));
  mockDb.delete.mockReset().mockImplementation(() => mockQueryBuilder(undefined));
  mockDb.transaction.mockReset().mockImplementation((fn: (tx: unknown) => unknown) => fn(mockDb as any));
  process.env.GV_WEB_VERSION = mockWebVersionEnv.GV_WEB_VERSION;
  process.env.GV_WEB_GIT_SHA = mockWebVersionEnv.GV_WEB_GIT_SHA;
  process.env.GV_WEB_RELEASED_AT_UTC = mockWebVersionEnv.GV_WEB_RELEASED_AT_UTC;
  mockAuth.mockResolvedValue({ user: { id: "user-1", name: "Tester", email: "test@example.com" } });
  mockVerifyBearerToken.mockResolvedValue({
    id: "server-1",
    userId: "user-1",
    name: "sc-server",
    apiKeyHash: "hashed_key",
  });
  mockVerifyAdminToken.mockResolvedValue({
    id: "server-1",
    userId: "user-1",
    name: "sc-server",
    apiKeyHash: "hashed_key",
  });
  mockWaitForSdpAnswer.mockResolvedValue("v=0\r\nanswer");
}

beforeEach(resetAllMocks);

// ── /api/auth/pair/generate ────────────────────────────────────────────

describe("POST /api/auth/pair/generate", () => {
  it("returns 401 when not signed in", async () => {
    mockAuth.mockResolvedValueOnce(null);
    const { POST } = await import("@/app/api/auth/pair/generate/route");
    const resp = await POST(mkReq("http://localhost/api/auth/pair/generate"));
    expect(resp.status).toBe(401);
  });

  it("returns a pairing code when signed in", async () => {
    const { POST } = await import("@/app/api/auth/pair/generate/route");
    const resp = await POST(mkReq("http://localhost/api/auth/pair/generate"));
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.code).toBe("ABCD-EFGH");
  });
});

// ── /api/auth/pair/claim ───────────────────────────────────────────────

describe("POST /api/auth/pair/claim", () => {
  it("returns 400 for invalid JSON", async () => {
    const { POST } = await import("@/app/api/auth/pair/claim/route");
    const req = mkReq("http://localhost/api/auth/pair/claim", {
      method: "POST",
      body: "not json",
    });
    const resp = await POST(req as any);
    expect(resp.status).toBe(400);
  });

  it("returns 400 for invalid code format", async () => {
    const { POST } = await import("@/app/api/auth/pair/claim/route");
    const req = mkReq("http://localhost/api/auth/pair/claim", {
      ...jsonBody({ code: "short" }),
    });
    const resp = await POST(req as any);
    expect(resp.status).toBe(400);
  });

  it("returns 404 when code not found", async () => {
    mockDb.select.mockReturnValue(mockQueryBuilder([]));
    const { POST } = await import("@/app/api/auth/pair/claim/route");
    const req = mkReq("http://localhost/api/auth/pair/claim", {
      ...jsonBody({ code: "ABCD-EFGH" }),
    });
    const resp = await POST(req as any);
    expect(resp.status).toBe(404);
  });

  it("claims a valid code and returns server_id + api_key", async () => {
    const future = new Date(Date.now() + 300_000);

    // First select: pairing code lookup
    // Second select: existing server check (no existing server → first pair)
    mockDb.select
      .mockReturnValueOnce(
        mockQueryBuilder([{ code: "ABCD-EFGH", userId: "user-1", status: "pending", expiresAt: future }]),
      )
      .mockReturnValueOnce(
        mockQueryBuilder([]), // no existing server
      );

    // Mock insert chain: insert().values().returning()
    const insertBuilder = {
      values: vi.fn().mockReturnThis(),
      returning: vi.fn(() => Promise.resolve([{ id: "server-new" }])),
    };
    mockDb.insert.mockReturnValue(insertBuilder);

    const { POST } = await import("@/app/api/auth/pair/claim/route");
    const req = mkReq("http://localhost/api/auth/pair/claim", {
      ...jsonBody({ code: "ABCD-EFGH" }),
    });
    const resp = await POST(req as any);
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.server_id).toBeTruthy();
    expect(body.api_key).toBe("scsk_test_api_key_12345");
  });
});

// ── /api/auth/verify ───────────────────────────────────────────────────

describe("GET /api/auth/verify", () => {
  it("returns 401 without bearer token", async () => {
    mockVerifyBearerToken.mockResolvedValueOnce(null);
    const { GET } = await import("@/app/api/auth/verify/route");
    const req = mkReq("http://localhost/api/auth/verify");
    const resp = await GET(req);
    expect(resp.status).toBe(401);
  });

  it("returns server info with valid token", async () => {
    const { GET } = await import("@/app/api/auth/verify/route");
    const req = mkReq("http://localhost/api/auth/verify", {
      headers: authHeader(),
    });
    const resp = await GET(req);
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.server_id).toBe("server-1");
    expect(body.user_id).toBe("user-1");
  });
});

// ── /api/server/command ────────────────────────────────────────────────

describe("POST /api/server/command", () => {
  it("returns 401 when not signed in", async () => {
    mockAuth.mockResolvedValueOnce(null);
    const { POST } = await import("@/app/api/server/command/route");
    const req = mkReq("http://localhost/api/server/command", {
      ...jsonBodyWithCsrf({ server_id: "server-1", type: "start_game", payload: { game_id: "smw" } }),
    });
    const resp = await POST(req as any);
    expect(resp.status).toBe(401);
  });

  it("returns 400 for invalid type", async () => {
    const { POST } = await import("@/app/api/server/command/route");
    const req = mkReq("http://localhost/api/server/command", {
      ...jsonBodyWithCsrf({ server_id: "server-1", type: "invalid_type" }),
    });
    const resp = await POST(req as any);
    expect(resp.status).toBe(400);
  });


  it("rejects signed-in browser commands without csrf token", async () => {
    const { POST } = await import("@/app/api/server/command/route");
    const req = mkReq("http://localhost/api/server/command", {
      ...jsonBody({ server_id: "server-1", type: "stop_game", payload: { game_id: "smw" } }),
    });
    const resp = await POST(req as any);
    expect(resp.status).toBe(403);
    const body = await resp.json();
    expect(body.error).toContain("csrf");
  });

  it("rejects extra fields in sdp_offer payload", async () => {
    mockDb.select.mockReturnValue(
      Object.assign(Promise.resolve([{ role: "admin" }]), {
        from: vi.fn().mockReturnThis(),
        innerJoin: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn(() => Promise.resolve([{ role: "admin" }])),
          })),
        })),
      }),
    );

    const { POST } = await import("@/app/api/server/command/route");
    const req = mkReq("http://localhost/api/server/command", {
      ...jsonBodyWithCsrf({
        server_id: "server-1",
        type: "sdp_offer",
        payload: { game_id: "smw", sdp: "v=0\r\n", unexpected: true },
      }),
    });
    const resp = await POST(req as any);
    expect(resp.status).toBe(400);
    const body = await resp.json();
    expect(body.error).toContain("payload");
  });

  it("queues a start_game command and returns worker_token", async () => {
    mockDb.select
      .mockReturnValueOnce(
        Object.assign(Promise.resolve([{ role: "admin" }]), {
          from: vi.fn().mockReturnThis(),
          innerJoin: vi.fn(() => ({
            where: vi.fn(() => ({
              limit: vi.fn(() => Promise.resolve([{ role: "admin" }])),
            })),
          })),
        }),
      )
      .mockReturnValueOnce(
        Object.assign(Promise.resolve([{ romPath: "/roms/smw.smc", platform: "snes", gameName: "Super Mario World" }]), {
          from: vi.fn().mockReturnThis(),
          innerJoin: vi.fn(() => ({
            where: vi.fn(() => ({
              limit: vi.fn(() => Promise.resolve([{ romPath: "/roms/smw.smc", platform: "snes", gameName: "Super Mario World" }])),
            })),
          })),
        }),
      )
      .mockReturnValueOnce(
        Object.assign(Promise.resolve([]), {
          from: vi.fn().mockReturnThis(),
          where: vi.fn().mockReturnThis(),
        }),
      );

    const { launchEvents, commands: commandsTable, sessions: sessionsTable, peerTokens: peerTokensTable } = await import("@/lib/db/schema");
    const commandInsertBuilder = {
      values: vi.fn().mockReturnThis(),
      returning: vi.fn(() => Promise.resolve([{ id: "cmd-123" }])),
    };
    const sessionInsertBuilder = {
      values: vi.fn().mockReturnThis(),
      returning: vi.fn(() => Promise.resolve([{ id: "sess-123" }])),
    };
    const peerTokenInsertBuilder = {
      values: vi.fn().mockReturnThis(),
      returning: vi.fn(() => Promise.resolve([])),
    };
    mockDb.insert.mockImplementation((table: unknown) => {
      if (table === commandsTable) return commandInsertBuilder;
      if (table === launchEvents) return mockQueryBuilder([{ id: "launch-1" }]);
      if (table === sessionsTable) return sessionInsertBuilder;
      if (table === peerTokensTable) return peerTokenInsertBuilder;
      return mockQueryBuilder([{ id: "fallback" }]);
    });

    mockDb.update.mockReturnValue({
      set: vi.fn(() => ({
        where: vi.fn(() => Promise.resolve(undefined)),
      })),
    });

    const { POST } = await import("@/app/api/server/command/route");
    const req = mkReq("http://localhost/api/server/command", {
      ...jsonBodyWithCsrf({ server_id: "server-1", type: "start_game", payload: { game_id: "smw" } }),
    });
    const resp = await POST(req as any);
    expect(resp.status).toBe(201);
    const body = await resp.json();
    expect(body.worker_token).toBeTruthy();
    expect(body.worker_token.length).toBe(32);

    expect(mockDb.insert).toHaveBeenCalledWith(launchEvents);
  });

  it("allows LAN start_game with a matching short-code host token and no auth cookie", async () => {
    mockAuth.mockResolvedValueOnce(null);
    mockDb.select
      .mockReturnValueOnce(mockQueryBuilder([{ code: "ABC123" }]))
      .mockReturnValueOnce(mockQueryBuilder([{ userId: "user-1" }]))
      .mockReturnValueOnce(mockQueryBuilder([
        { romPath: "/roms/smw.sfc", platform: "snes", gameName: "Super Mario World" },
      ]))
      .mockReturnValueOnce(mockQueryBuilder([]));

    const { launchEvents, commands: commandsTable, sessions: sessionsTable, peerTokens: peerTokensTable } = await import("@/lib/db/schema");
    mockDb.insert.mockImplementation((table: unknown) => {
      if (table === commandsTable) return { values: vi.fn().mockReturnThis(), returning: vi.fn(() => Promise.resolve([{ id: "cmd-lan" }])) };
      if (table === sessionsTable) return { values: vi.fn().mockReturnThis(), returning: vi.fn(() => Promise.resolve([{ id: "sess-lan" }])) };
      if (table === peerTokensTable) return { values: vi.fn().mockReturnThis(), returning: vi.fn(() => Promise.resolve([])) };
      if (table === launchEvents) return mockQueryBuilder([{ id: "launch-lan" }]);
      return mockQueryBuilder([{ id: "fallback" }]);
    });
    mockDb.update.mockReturnValue({ set: vi.fn(() => ({ where: vi.fn(() => Promise.resolve(undefined)) })) });
    mockWaitForSdpAnswer.mockResolvedValueOnce("v=0\r\nanswer");

    const { POST } = await import("@/app/api/server/command/route");
    const req = mkReq("http://localhost/api/server/command", jsonBody({
      server_id: "server-1",
      type: "start_game",
      payload: { game_id: "smw", host_token: "host-secret", lan: true, sdp: "v=0\r\n" },
    }));

    const resp = await POST(req as any);
    expect(resp.status).toBe(201);
    const body = await resp.json();
    expect(body.sdp_answer).toBe("v=0\r\nanswer");
  });

  it("does not auto-inject lan=true from request IP heuristics", async () => {
    const prevLanIps = process.env.GV_SERVER_LAN_IPS;
    process.env.GV_SERVER_LAN_IPS = "192.0.2.1";

    mockDb.select
      .mockReturnValueOnce(
        Object.assign(Promise.resolve([{ role: "admin" }]), {
          from: vi.fn().mockReturnThis(),
          innerJoin: vi.fn(() => ({
            where: vi.fn(() => ({
              limit: vi.fn(() => Promise.resolve([{ role: "admin" }])),
            })),
          })),
        }),
      )
      .mockReturnValueOnce(
        Object.assign(Promise.resolve([{ romPath: "/roms/smw.smc", platform: "snes", gameName: "Super Mario World" }]), {
          from: vi.fn().mockReturnThis(),
          innerJoin: vi.fn(() => ({
            where: vi.fn(() => ({
              limit: vi.fn(() => Promise.resolve([{ romPath: "/roms/smw.smc", platform: "snes", gameName: "Super Mario World" }])),
            })),
          })),
        }),
      )
      .mockReturnValueOnce(
        Object.assign(Promise.resolve([]), {
          from: vi.fn().mockReturnThis(),
          where: vi.fn().mockReturnThis(),
        }),
      );

    const insertedValues: Array<Record<string, unknown>> = [];
    const { launchEvents, commands: commandsTable, sessions: sessionsTable, peerTokens: peerTokensTable } = await import("@/lib/db/schema");
    const commandInsertBuilder = {
      values: vi.fn((value) => {
        insertedValues.push(value as Record<string, unknown>);
        return commandInsertBuilder;
      }),
      returning: vi.fn(() => Promise.resolve([{ id: "cmd-123" }])),
    };
    const sessionInsertBuilder = {
      values: vi.fn().mockReturnThis(),
      returning: vi.fn(() => Promise.resolve([{ id: "sess-123" }])),
    };
    const peerTokenInsertBuilder = {
      values: vi.fn().mockReturnThis(),
      returning: vi.fn(() => Promise.resolve([])),
    };
    mockDb.insert.mockImplementation((table: unknown) => {
      if (table === commandsTable) return commandInsertBuilder;
      if (table === launchEvents) return mockQueryBuilder([{ id: "launch-1" }]);
      if (table === sessionsTable) return sessionInsertBuilder;
      if (table === peerTokensTable) return peerTokenInsertBuilder;
      return mockQueryBuilder([{ id: "fallback" }]);
    });

    mockDb.update.mockReturnValue({
      set: vi.fn(() => ({
        where: vi.fn(() => Promise.resolve(undefined)),
      })),
    });

    const { POST } = await import("@/app/api/server/command/route");
    const req = mkReq("http://localhost/api/server/command", {
      ...jsonBodyWithCsrf({ server_id: "server-1", type: "start_game", payload: { game_id: "smw" } }),
      headers: {
        "Content-Type": "application/json",
        "x-csrf-token": "csrf-test-token",
        cookie: "sc_csrf_token=csrf-test-token",
        "x-forwarded-for": "192.0.2.55",
        "x-real-ip": "192.0.2.55",
      },
    });
    const resp = await POST(req as any);
    expect(resp.status).toBe(201);
    expect(insertedValues[0]?.payload).toMatchObject({ game_id: "smw" });
    expect((insertedValues[0]?.payload as Record<string, unknown>).lan).toBeUndefined();

    if (prevLanIps !== undefined) process.env.GV_SERVER_LAN_IPS = prevLanIps;
    else delete process.env.GV_SERVER_LAN_IPS;
  });

  it("does not reuse stale connected sessions on host reconnect", async () => {
    const { sessions: sessionsTable } = await import("@/lib/db/schema");

    mockDb.select
      .mockReturnValueOnce(
        Object.assign(Promise.resolve([{ role: "admin" }]), {
          from: vi.fn().mockReturnThis(),
          innerJoin: vi.fn(() => ({
            where: vi.fn(() => ({
              limit: vi.fn(() => Promise.resolve([{ role: "admin" }])),
            })),
          })),
        }),
      )
      .mockReturnValueOnce(mockQueryBuilder([
        { romPath: "/roms/smw.sfc", platform: "snes", gameName: "Super Mario World" },
      ]))
      .mockReturnValueOnce(mockQueryBuilder([]));

    const sessionUpdates: Array<Record<string, unknown>> = [];
    mockDb.insert.mockImplementation(() => ({
      values: vi.fn().mockReturnThis(),
      returning: vi.fn(() => Promise.resolve([{ id: "test-id" }])),
    }));
    mockDb.update.mockImplementation((table: unknown) => ({
      set: vi.fn((value: Record<string, unknown>) => {
        if (table === sessionsTable) {
          sessionUpdates.push(value);
        }
        return { where: vi.fn(() => Promise.resolve(undefined)) };
      }),
    }));

    const { POST } = await import("@/app/api/server/command/route");
    const req = mkReq("http://localhost/api/server/command", {
      ...jsonBodyWithCsrf({
        server_id: "server-1",
        type: "start_game",
        payload: { game_id: "smw", sdp: "v=0\r\n" },
      }),
    });
    const resp = await POST(req as any);
    expect(resp.status).toBe(201);
    const body = await resp.json();
    expect(body.host_peer_token).toBeTruthy();
    expect(sessionUpdates).toContainEqual(expect.objectContaining({ status: "timed_out" }));
    expect(mockDb.insert).toHaveBeenCalledWith(sessionsTable);
  });
});

// ── /api/server/poll ───────────────────────────────────────────────────

describe("GET /api/server/poll", () => {
  it("returns 401 without bearer token", async () => {
    mockVerifyBearerToken.mockResolvedValueOnce(null);
    const { GET } = await import("@/app/api/server/poll/route");
    const req = mkReq("http://localhost/api/server/poll");
    const resp = await GET(req);
    expect(resp.status).toBe(401);
  });

  it("returns empty commands when queue is idle", async () => {
    // Transaction mock — returns empty array
    mockDb.transaction.mockImplementation(async (fn: any) => fn({ ...mockDb }));
    mockDb.select.mockReturnValue(mockQueryBuilder([]));

    const { GET } = await import("@/app/api/server/poll/route");
    const req = mkReq("http://localhost/api/server/poll", {
      headers: authHeader(),
    });
    const resp = await GET(req);
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.commands).toEqual([]);
    expect(body.next_poll_ms).toBeGreaterThan(0);
  });

  it("leases pending commands and returns lease metadata", async () => {
    const rows = [
      { id: "cmd-1", type: "start_game", payload: { game_id: "smw" }, attempts: 0 },
    ];
    let updateSet: Record<string, unknown> | undefined;
    mockDb.transaction.mockImplementation(async (fn: any) => {
      const tx = {
        select: vi.fn(() => mockQueryBuilder(rows)),
        update: vi.fn(() => ({
          set: vi.fn((value: Record<string, unknown>) => {
            updateSet = value;
            return { where: vi.fn(() => Promise.resolve(undefined)) };
          }),
        })),
      };
      return fn(tx);
    });

    const { GET } = await import("@/app/api/server/poll/route");
    const req = mkReq("http://localhost/api/server/poll", {
      headers: authHeader(),
    });
    const resp = await GET(req);
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.commands.length).toBe(1);
    expect(body.commands[0]).toMatchObject({
      id: "cmd-1",
      type: "start_game",
      payload: { game_id: "smw" },
      attempt: 1,
    });
    expect(body.commands[0].lease_token).toBeTruthy();
    expect(body.commands[0].lease_expires_at).toBeTruthy();
    expect(updateSet).toMatchObject({ status: "leased" });
    expect(updateSet?.leaseToken).toBe(body.commands[0].lease_token);
    expect(updateSet?.leaseExpiresAt).toBeInstanceOf(Date);
    expect(body.next_poll_ms).toBe(250); // fast poll when commands leased

    const { launchEvents } = await import("@/lib/db/schema");
    expect(mockDb.insert).toHaveBeenCalledWith(launchEvents);
  });

  it("prioritizes signaling commands before slower control work", async () => {
    const rows = [
      { id: "cmd-1", type: "sdp_offer", payload: { game_id: "smw" }, attempts: 0 },
    ];
    const builder = mockQueryBuilder(rows);
    mockDb.transaction.mockImplementation(async (fn: any) => {
      const tx = {
        select: vi.fn(() => builder),
        update: vi.fn(() => ({
          set: vi.fn(() => ({ where: vi.fn(() => Promise.resolve(undefined)) })),
        })),
      };
      return fn(tx);
    });

    const { GET } = await import("@/app/api/server/poll/route");
    const req = mkReq("http://localhost/api/server/poll", {
      headers: authHeader(),
    });
    const resp = await GET(req);
    expect(resp.status).toBe(200);

    expect(builder.orderBy).toHaveBeenCalledTimes(1);
    const orderArgs = builder.orderBy.mock.calls[0];
    expect(orderArgs.length).toBeGreaterThanOrEqual(2);
    const prioritySql = (orderArgs[0] as { queryChunks?: Array<{ value?: string[] }> }).queryChunks
      ?.flatMap((chunk) => chunk.value ?? [])
      .join(" ") ?? "";
    expect(prioritySql).toContain("sdp_offer");
    expect(prioritySql).toContain("stop_game");
    expect(prioritySql).toContain("start_game");
  });
});

// ── /api/server/notify ─────────────────────────────────────────────────

describe("POST /api/server/notify", () => {
  it("returns 401 without bearer token", async () => {
    mockVerifyBearerToken.mockResolvedValueOnce(null);
    const { POST } = await import("@/app/api/server/notify/route");
    const req = mkReq("http://localhost/api/server/notify", {
      ...jsonBody({ command_id: "cmd-1", worker_url: "http://localhost:9999", game_id: "smw" }),
    });
    const resp = await POST(req as any);
    expect(resp.status).toBe(401);
  });

  it("returns 400 with missing fields", async () => {
    const { POST } = await import("@/app/api/server/notify/route");
    const req = mkReq("http://localhost/api/server/notify", {
      ...jsonBody({ command_id: "cmd-1" }),
      headers: authHeader(),
    });
    const resp = await POST(req as any);
    expect(resp.status).toBe(400);
  });


  it("rejects notify for a command owned by another server", async () => {
    mockDb.select.mockReturnValueOnce(
      mockQueryBuilder([{ id: "cmd-1", serverId: "server-2", workerToken: "abc123" }]),
    );

    const { POST } = await import("@/app/api/server/notify/route");
    const req = mkReq("http://localhost/api/server/notify", {
      ...jsonBody({ command_id: "cmd-1", worker_url: "http://localhost:9999", game_id: "smw" }),
      headers: authHeader(),
    });
    const resp = await POST(req as any);
    expect(resp.status).toBe(404);
  });

  it("accepts stop action without worker_url", async () => {
    // Mock command lookup
    mockDb.select.mockReturnValue(
      mockQueryBuilder([{ id: "cmd-1", serverId: "server-1", workerToken: "abc123" }]),
    );
    // Mock existing session lookup
    mockDb.select
      .mockReturnValueOnce(mockQueryBuilder([{ id: "cmd-1", serverId: "server-1", workerToken: "abc123" }]))
      .mockReturnValueOnce(mockQueryBuilder([])); // no existing session

    const { POST } = await import("@/app/api/server/notify/route");
    const req = mkReq("http://localhost/api/server/notify", {
      ...jsonBody({ command_id: "cmd-1", worker_url: "", game_id: "smw", action: "stop" }),
      headers: authHeader(),
    });
    const resp = await POST(req as any);
    // Should NOT return 400 — the fix makes worker_url optional for stop
    expect(resp.status).not.toBe(400);
  });

  it("creates a session on first start_game notify", async () => {
    mockDb.select
      .mockReturnValueOnce(mockQueryBuilder([{ id: "cmd-1", serverId: "server-1", workerToken: "abc123" }]))
      .mockReturnValueOnce(mockQueryBuilder([])); // no existing session

    const { POST } = await import("@/app/api/server/notify/route");
    const req = mkReq("http://localhost/api/server/notify", {
      ...jsonBody({ command_id: "cmd-1", worker_url: "http://localhost:9999", game_id: "smw" }),
      headers: authHeader(),
    });
    const resp = await POST(req as any);
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.ok).toBe(true);
  });
});

describe("GET /api/server/notify", () => {
  it("returns 400 without server_id", async () => {
    const { GET } = await import("@/app/api/server/notify/route");
    const req = mkReq("http://localhost/api/server/notify");
    const resp = await GET(req as any);
    expect(resp.status).toBe(400);
  });

  it("returns 400 without worker_token", async () => {
    const { GET } = await import("@/app/api/server/notify/route");
    const req = mkReq(
      "http://localhost/api/server/notify?server_id=server-1",
    );
    const resp = await GET(req as any);
    expect(resp.status).toBe(400);
  });

  it("returns worker_url when session is ready", async () => {
    mockDb.select.mockReturnValue(
      mockQueryBuilder([{ workerUrl: "http://localhost:9999", gameId: "smw", status: "ready" }]),
    );

    const { GET } = await import("@/app/api/server/notify/route");
    const req = mkReq(
      "http://localhost/api/server/notify?server_id=server-1&worker_token=abc123",
    );
    const resp = await GET(req as any);
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.worker_url).toBe("http://localhost:9999");
    expect(body.game_id).toBe("smw");
  });

  it("returns null worker_url when no session exists", async () => {
    mockDb.select.mockReturnValue(mockQueryBuilder([]));

    const { GET } = await import("@/app/api/server/notify/route");
    const req = mkReq(
      "http://localhost/api/server/notify?server_id=server-1&worker_token=abc123",
    );
    const resp = await GET(req as any);
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.worker_url).toBeNull();
  });
});

// ── /api/room/join ──────────────────────────────────────────────────────

describe("POST /api/room/join", () => {
  it("resolves preview requests without minting a peer token", async () => {
    mockDb.select.mockReturnValueOnce(
      mockQueryBuilder([{
        id: "sess-1",
        workerUrl: "http://localhost:9999",
        gameId: "smw",
        serverId: "server-1",
        status: "ready",
        maxSeats: 4,
        commandWorkerToken: "worker-123",
      }]),
    );

    const { POST } = await import("@/app/api/room/join/route");
    const req = mkReq("http://localhost/api/room/join", {
      ...jsonBody({ room_token: "room-123" }),
    });
    const resp = await POST(req as any);
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.worker_url).toBe("http://localhost:9999");
    expect(body.peer_token).toBeUndefined();
    expect(mockDb.insert).not.toHaveBeenCalled();
  });

  it("reuses an existing peer token for the same client_id", async () => {
    mockDb.select
      .mockReturnValueOnce(
        mockQueryBuilder([{
          id: "sess-1",
          workerUrl: "http://localhost:9999",
          gameId: "smw",
          serverId: "server-1",
          status: "ready",
          maxSeats: 4,
          commandWorkerToken: "worker-123",
        }]),
      )
      .mockReturnValueOnce(
        mockQueryBuilder([{ token: "peer-abc", seat: 1, role: "player" }]),
      );

    const { POST } = await import("@/app/api/room/join/route");
    const req = mkReq("http://localhost/api/room/join", {
      ...jsonBody({ room_token: "room-123", client_id: "client-1" }),
    });
    const resp = await POST(req as any);
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.peer_token).toBe("peer-abc");
    expect(body.seat).toBe(1);
    expect(body.role).toBe("player");
    expect(mockDb.insert).not.toHaveBeenCalled();
  });
});


// ── /api/server/result ─────────────────────────────────────────────────

describe("POST /api/server/result", () => {
  it("requires a lease token", async () => {
    const { POST } = await import("@/app/api/server/result/route");
    const req = mkReq("http://localhost/api/server/result", {
      ...jsonBody({ command_id: "cmd-1", result: { ok: true } }),
      headers: authHeader(),
    });
    const resp = await POST(req as any);
    expect(resp.status).toBe(400);
    const body = await resp.json();
    expect(body.error).toContain("lease_token");
  });

  it("stores result and marks a matching leased command completed", async () => {
    let updateSet: Record<string, unknown> | undefined;
    const updateBuilder = {
      set: vi.fn((value: Record<string, unknown>) => {
        updateSet = value;
        return {
          where: vi.fn(() => ({
            returning: vi.fn(() => Promise.resolve([{ id: "cmd-1" }])),
          })),
        };
      }),
    };
    mockDb.update.mockReturnValue(updateBuilder);

    const { POST } = await import("@/app/api/server/result/route");
    const req = mkReq("http://localhost/api/server/result", {
      ...jsonBody({ command_id: "cmd-1", lease_token: "lease-123", result: { ok: true } }),
      headers: authHeader(),
    });
    const resp = await POST(req as any);
    expect(resp.status).toBe(200);
    expect(updateSet).toMatchObject({ result: { ok: true }, status: "completed" });
    expect(updateSet?.completedAt).toBeInstanceOf(Date);
  });
});

// ── /api/commands/[id]/result ──────────────────────────────────────────

describe("GET /api/commands/[id]/result", () => {
  it("returns command status with command result", async () => {
    mockDb.select.mockReturnValue(
      mockQueryBuilder([{ result: { ok: true }, status: "completed", lastError: null }]),
    );

    const { GET } = await import("@/app/api/commands/[id]/result/route");
    const req = mkReq("http://localhost/api/commands/cmd-1/result");
    const resp = await GET(req as any, { params: Promise.resolve({ id: "cmd-1" }) });
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body).toMatchObject({ status: "completed", result: { ok: true }, error: null });
  });
});


// ── /api/ice-config ────────────────────────────────────────────────────

describe("GET /api/ice-config", () => {
  it("returns Google STUN by default when no env vars are set", async () => {
    const { GET } = await import("@/app/api/ice-config/route");
    const resp = await GET(new Request("http://localhost/api/ice-config"));
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.iceServers).toHaveLength(1);
    expect(body.iceServers[0].urls).toBe("stun:stun.l.google.com:19302");
    expect(body.iceTransportPolicy).toBe("all");
  });

  it("returns relay policy from GV_ICE_TRANSPORT_POLICY", async () => {
    const prev = process.env.GV_ICE_TRANSPORT_POLICY;
    process.env.GV_ICE_TRANSPORT_POLICY = "relay";
    try {
      const { GET } = await import("@/app/api/ice-config/route");
      const resp = await GET(new Request("http://localhost/api/ice-config"));
      expect(resp.status).toBe(200);
      const body = await resp.json();
      expect(body.iceTransportPolicy).toBe("relay");
    } finally {
      if (prev !== undefined) process.env.GV_ICE_TRANSPORT_POLICY = prev;
      else delete process.env.GV_ICE_TRANSPORT_POLICY;
    }
  });

  it("does not override relay policy from request IP heuristics", async () => {
    const prevPolicy = process.env.GV_ICE_TRANSPORT_POLICY;
    const prevLanIps = process.env.GV_SERVER_LAN_IPS;
    process.env.GV_ICE_TRANSPORT_POLICY = "relay";
    process.env.GV_SERVER_LAN_IPS = "192.0.2.1";
    try {
      const { GET } = await import("@/app/api/ice-config/route");
      const resp = await GET(new Request("http://localhost/api/ice-config", {
        headers: {
          "x-forwarded-for": "192.0.2.55",
          "x-real-ip": "192.0.2.55",
        },
      }));
      expect(resp.status).toBe(200);
      const body = await resp.json();
      expect(body.iceTransportPolicy).toBe("relay");
    } finally {
      if (prevPolicy !== undefined) process.env.GV_ICE_TRANSPORT_POLICY = prevPolicy;
      else delete process.env.GV_ICE_TRANSPORT_POLICY;
      if (prevLanIps !== undefined) process.env.GV_SERVER_LAN_IPS = prevLanIps;
      else delete process.env.GV_SERVER_LAN_IPS;
    }
  });
});


// ── /api/health ────────────────────────────────────────────────────────

describe("GET /api/health", () => {
  it("returns ok when all components are healthy and reports connectivity mode", async () => {
    mockDb.execute.mockResolvedValueOnce(undefined); // db check
    // Check order: api_routes → sc_server → schema
    mockDb.select.mockReturnValueOnce(
      mockQueryBuilder([{}]), // api_routes: sessions table is queryable
    );
    mockDb.select.mockReturnValueOnce(
      mockQueryBuilder([{ id: "server-1", lastSeenAt: new Date() }]), // sc_server
    );
    mockDb.select.mockReturnValueOnce(
      mockQueryBuilder([{ roomToken: "x", maxSeats: 1, sdpAnswer: null }]), // schema
    );
    mockDb.select.mockReturnValueOnce(
      mockQueryBuilder([{
        id: "server-1",
        name: "Home PC",
        lastSeenAt: new Date("2026-06-22T13:20:39Z"),
        metadata: {
          versions: {
            server: { package_version: "0.1.0", git_sha: "server-sha" },
            worker: { package_version: "0.1.0", git_sha: "worker-sha" },
            runner: { package_version: "0.1.0", git_sha: "runner-sha" },
          },
        },
      }]),
    );

    const { GET } = await import("@/app/api/health/route");
    const prevStun = process.env.GV_ICE_STUN_URLS;
    const prevTurnUrls = process.env.GV_ICE_TURN_URLS;
    const prevTurnUser = process.env.GV_ICE_TURN_USERNAME;
    const prevTurnCred = process.env.GV_ICE_TURN_CREDENTIAL;
    const prevPolicy = process.env.GV_ICE_TRANSPORT_POLICY;
    process.env.GV_ICE_STUN_URLS = "stun:stun.l.google.com:19302";
    process.env.GV_ICE_TURN_URLS = "turn:turn.example.com:3478";
    process.env.GV_ICE_TURN_USERNAME = "gv";
    process.env.GV_ICE_TURN_CREDENTIAL = "secret";
    process.env.GV_ICE_TRANSPORT_POLICY = "all";
    const resp = await GET();
    process.env.GV_ICE_STUN_URLS = prevStun;
    process.env.GV_ICE_TURN_URLS = prevTurnUrls;
    process.env.GV_ICE_TURN_USERNAME = prevTurnUser;
    process.env.GV_ICE_TURN_CREDENTIAL = prevTurnCred;
    process.env.GV_ICE_TRANSPORT_POLICY = prevPolicy;
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.status).toBe("ok");
    expect(body.components.db.status).toBe("ok");
    expect(body.components.sc_server.status).toBe("ok");
    expect(body.connectivity.mode).toBe("turn-capable");
    expect(body.connectivity.transport_policy).toBe("all");
    expect(body.connectivity.turn_ready).toBe(true);
    expect(body.connectivity.diagnostics.some((line: string) => line.includes("TURN is configured"))).toBe(true);
    expect(body.versions.web).toMatchObject({ package_version: "0.1.0", git_sha: "web-sha-123" });
    expect(body.versions.server).toMatchObject({ git_sha: "server-sha" });
    expect(body.versions.worker).toMatchObject({ git_sha: "worker-sha" });
    expect(body.versions.runner).toMatchObject({ git_sha: "runner-sha" });
    expect(body.versions.source_server).toMatchObject({ id: "server-1", name: "Home PC" });
  });

  it("returns 503 with per-component status when DB is down", async () => {
    mockDb.execute.mockRejectedValueOnce(new Error("connection refused"));
    const { GET } = await import("@/app/api/health/route");
    const resp = await GET();
    expect(resp.status).toBe(503);
    const body = await resp.json();
    expect(body.status).toBe("error");
    expect(body.components.db.status).toBe("error");
    expect(body.versions.web).toMatchObject({ package_version: "0.1.0", git_sha: "web-sha-123" });
  });
});

// ── /api/servers/members ───────────────────────────────────────────────

describe("/api/servers/members", () => {
  it("GET returns 401 without bearer token", async () => {
    mockVerifyBearerToken.mockResolvedValueOnce(null);
    const { GET } = await import("@/app/api/servers/members/route");
    const req = mkReq("http://localhost/api/servers/members");
    const resp = await GET(req);
    expect(resp.status).toBe(401);
  });

  it("GET returns member list", async () => {
    const { GET } = await import("@/app/api/servers/members/route");
    const req = mkReq("http://localhost/api/servers/members", {
      headers: authHeader(),
    });
    const resp = await GET(req);
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(Array.isArray(body.members)).toBe(true);
  });

  it("POST returns 403 when not admin", async () => {
    mockVerifyAdminToken.mockResolvedValueOnce(null);
    const { POST } = await import("@/app/api/servers/members/route");
    const req = mkReq("http://localhost/api/servers/members", {
      ...jsonBody({ user_id: "user-2" }),
      headers: authHeader(),
    });
    const resp = await POST(req as any);
    expect(resp.status).toBe(403);
  });

  it("DELETE prevents removing admin", async () => {
    const { DELETE } = await import("@/app/api/servers/members/route");
    const req = mkReq(
      "http://localhost/api/servers/members?user_id=user-1",
      { headers: authHeader() },
    );
    const resp = await DELETE(req as any);
    expect(resp.status).toBe(403);
  });
});

// ── /api/servers/[server_id]/metadata ─────────────────────────────────

describe("GET /api/servers/[server_id]/metadata", () => {
  const serverId = "server-1";

  it("returns 401 when not signed in", async () => {
    mockAuth.mockResolvedValueOnce(null);
    const { GET } = await import(
      "@/app/api/servers/[server_id]/metadata/route"
    );
    const req = mkReq(`http://localhost/api/servers/${serverId}/metadata`);
    const resp = await GET(req, { params: Promise.resolve({ server_id: serverId }) });
    expect(resp.status).toBe(401);
  });

  it("returns 403 when caller is not a member of the server", async () => {
    mockDb.select.mockReturnValueOnce(mockQueryBuilder([]));
    const { GET } = await import(
      "@/app/api/servers/[server_id]/metadata/route"
    );
    const req = mkReq(`http://localhost/api/servers/${serverId}/metadata`);
    const resp = await GET(req, { params: Promise.resolve({ server_id: serverId }) });
    expect(resp.status).toBe(403);
  });

  it("returns server metadata when caller is a member", async () => {
    const mockMembership = [{ id: "mem-1", serverId, userId: "user-1", role: "member" }];
    mockDb.select.mockReturnValueOnce(mockQueryBuilder(mockMembership));

    const mockServer = [{
      name: "sc-server",
      lastSeenAt: new Date().toISOString(),
      metadata: {
        version: "0.1.0",
        interfaces: [{ name: "eth0", address: "192.168.1.100" }],
        ice: {
          stun_urls: ["stun:stun.l.google.com:19302"],
          turn_urls: [],
          turn_configured: false,
          transport_policy: "all",
        },
      },
    }];
    mockDb.select.mockReturnValueOnce(mockQueryBuilder(mockServer));

    const { GET } = await import(
      "@/app/api/servers/[server_id]/metadata/route"
    );
    const req = mkReq(`http://localhost/api/servers/${serverId}/metadata`);
    const resp = await GET(req, { params: Promise.resolve({ server_id: serverId }) });
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.name).toBe("sc-server");
    expect(body.metadata.version).toBe("0.1.0");
    expect(body.metadata.ice.turn_configured).toBe(false);
    expect(body.metadata.turn_password).toBeUndefined();
    expect(body.metadata.api_key).toBeUndefined();
  });

  it("returns 404 when server does not exist", async () => {
    mockDb.select.mockReturnValueOnce(mockQueryBuilder([{ id: "mem-1" }]));
    mockDb.select.mockReturnValueOnce(mockQueryBuilder([]));

    const { GET } = await import(
      "@/app/api/servers/[server_id]/metadata/route"
    );
    const req = mkReq(`http://localhost/api/servers/nonexistent/metadata`);
    const resp = await GET(req, { params: Promise.resolve({ server_id: "nonexistent" }) });
    expect(resp.status).toBe(404);
  });
});

// ── /api/playable-hosts ──────────────────────────────────────────────

describe("GET /api/playable-hosts", () => {
  it("returns 401 when not signed in", async () => {
    mockAuth.mockResolvedValueOnce(null);
    const { GET } = await import("@/app/api/playable-hosts/route");
    const req = mkReq("http://localhost/api/playable-hosts?game_id=smw");
    const resp = await GET(req);
    expect(resp.status).toBe(401);
  });

  it("returns 400 when game_id missing", async () => {
    const { GET } = await import("@/app/api/playable-hosts/route");
    const req = mkReq("http://localhost/api/playable-hosts");
    const resp = await GET(req);
    expect(resp.status).toBe(400);
  });

  it("returns empty hosts when user has no servers", async () => {
    mockDb.select.mockReturnValue(mockQueryBuilder([]));
    const { GET } = await import("@/app/api/playable-hosts/route");
    const req = mkReq("http://localhost/api/playable-hosts?game_id=smw");
    const resp = await GET(req);
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.hosts).toEqual([]);
  });

  it("returns hosts with game availability and server metadata", async () => {
    mockDb.select.mockReturnValue(
      mockQueryBuilder([
        {
          serverId: "server-1",
          serverName: "Home PC",
          lastSeenAt: new Date(),
          metadata: {
            interfaces: [{ name: "eth0", address: "192.168.1.100" }],
            ice: { turn_configured: false },
            lan: {
              player_port: 8787,
              player_urls: ["http://192.168.1.100:8787/"],
              health_urls: ["http://192.168.1.100:8787/health"],
            },
          },
          gameFileId: "gf-1",
        },
        {
          serverId: "server-2",
          serverName: "Arcade Box",
          lastSeenAt: new Date(Date.now() - 120_000),
          metadata: { interfaces: [], ice: { turn_configured: true } },
          gameFileId: null,
        },
      ]),
    );

    const { GET } = await import("@/app/api/playable-hosts/route");
    const req = mkReq("http://localhost/api/playable-hosts?game_id=smw");
    const resp = await GET(req);
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.hosts).toHaveLength(2);
    expect(body.hosts[0]).toMatchObject({
      server_id: "server-1",
      name: "Home PC",
      has_game: true,
      route_hint: "local",
      lan: {
        player_port: 8787,
        player_urls: ["http://192.168.1.100:8787/"],
        health_urls: ["http://192.168.1.100:8787/health"],
      },
    });
    expect(body.hosts[1]).toMatchObject({
      server_id: "server-2",
      name: "Arcade Box",
      has_game: false,
    });
  });

  it("only returns servers the user is a member of", async () => {
    // Query filters by serverMembers.userId — mock empty result
    mockDb.select.mockReturnValue(mockQueryBuilder([]));
    const { GET } = await import("@/app/api/playable-hosts/route");
    const req = mkReq("http://localhost/api/playable-hosts?game_id=smw");
    const resp = await GET(req);
    const body = await resp.json();
    expect(body.hosts.every((h: any) => h.server_id !== "unauthorized-server")).toBe(true);
  });

  it("classifies servers as online, stale, or offline", async () => {
    const now = Date.now();
    const online = new Date(now - 30_000);
    const stale = new Date(now - 120_000);
    const offline = new Date(now - 600_000);

    mockDb.select.mockReturnValue(
      mockQueryBuilder([
        { serverId: "s1", serverName: "Online", lastSeenAt: online, metadata: {}, gameFileId: "gf1" },
        { serverId: "s2", serverName: "Stale", lastSeenAt: stale, metadata: {}, gameFileId: null },
        { serverId: "s3", serverName: "Offline", lastSeenAt: offline, metadata: {}, gameFileId: "gf3" },
      ]),
    );

    const { GET } = await import("@/app/api/playable-hosts/route");
    const req = mkReq("http://localhost/api/playable-hosts?game_id=smw");
    const resp = await GET(req);
    const body = await resp.json();
    expect(body.hosts[0].status).toBe("online");
    expect(body.hosts[1].status).toBe("stale");
    expect(body.hosts[2].status).toBe("offline");
  });

  it("classifies route hints from server metadata", async () => {
    mockDb.select.mockReturnValue(
      mockQueryBuilder([
        {
          serverId: "s1", serverName: "Local", lastSeenAt: new Date(),
          metadata: { interfaces: [{ name: "eth0", address: "192.168.1.100" }], ice: { turn_configured: false } },
          gameFileId: "gf1",
        },
        {
          serverId: "s2", serverName: "Direct", lastSeenAt: new Date(),
          metadata: { interfaces: [], ice: { turn_configured: false } },
          gameFileId: "gf2",
        },
        {
          serverId: "s3", serverName: "Relay", lastSeenAt: new Date(),
          metadata: { interfaces: [], ice: { turn_configured: true } },
          gameFileId: "gf3",
        },
      ]),
    );

    const { GET } = await import("@/app/api/playable-hosts/route");
    const req = mkReq("http://localhost/api/playable-hosts?game_id=smw");
    const resp = await GET(req);
    const body = await resp.json();
    expect(body.hosts[0].route_hint).toBe("local");
    expect(body.hosts[1].route_hint).toBe("direct");
    expect(body.hosts[2].route_hint).toBe("relay");
  });

  it("classifies explicit LAN health metadata as local", async () => {
    mockDb.select.mockReturnValue(
      mockQueryBuilder([
        {
          serverId: "s1",
          serverName: "Vault",
          lastSeenAt: new Date(),
          metadata: {
            interfaces: [],
            ice: { turn_configured: true },
            lan: { health_urls: ["http://192.0.2.50:8787/health"] },
          },
          gameFileId: "gf1",
        },
      ]),
    );

    const { GET } = await import("@/app/api/playable-hosts/route");
    const req = mkReq("http://localhost/api/playable-hosts?game_id=smw");
    const resp = await GET(req);
    const body = await resp.json();
    expect(body.hosts[0].route_hint).toBe("local");
    expect(body.hosts[0].lan.health_urls).toEqual(["http://192.0.2.50:8787/health"]);
  });

  it("returns route_hint unknown when metadata is missing", async () => {
    mockDb.select.mockReturnValue(
      mockQueryBuilder([
        { serverId: "s1", serverName: "Unknown", lastSeenAt: new Date(), metadata: {}, gameFileId: "gf1" },
      ]),
    );
    const { GET } = await import("@/app/api/playable-hosts/route");
    const req = mkReq("http://localhost/api/playable-hosts?game_id=smw");
    const resp = await GET(req);
    const body = await resp.json();
    expect(body.hosts[0].route_hint).toBe("unknown");
  });
});

// ── /api/client/bootstrap ─────────────────────────────────────────────

describe("GET /api/client/bootstrap", () => {
  it("returns minimal bootstrap when unauthenticated", async () => {
    mockAuth.mockResolvedValueOnce(null);
    const { GET } = await import("@/app/api/client/bootstrap/route");
    const req = mkReq("http://localhost/api/client/bootstrap");
    const resp = await GET();
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.auth.authenticated).toBe(false);
    expect(body.servers).toEqual([]);
    expect(body.library).toBeNull();
    expect(body.deepLinks.hostPattern).toBe("/p/:code");
    expect(body.features.xmb).toBe(true);
  });

  it("returns auth + servers when signed in", async () => {
    // Auth returns user
    // DB returns server memberships
    mockDb.select.mockReturnValueOnce(
      mockQueryBuilder([{
        id: "server-1",
        name: "Bazzite",
        lastSeenAt: new Date("2026-07-13T12:00:00.000Z"),
        role: "admin",
      }]),
    );
    // DB returns game counts
    mockDb.select.mockReturnValueOnce(
      mockQueryBuilder([{ serverId: "server-1", count: 24 }]),
    );
    // DB returns pinned count
    mockDb.select.mockReturnValueOnce(
      mockQueryBuilder([{ pinnedCount: 2 }]),
    );

    const { GET } = await import("@/app/api/client/bootstrap/route");
    const resp = await GET();
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.auth.authenticated).toBe(true);
    expect(body.auth.userId).toBe("user-1");
    expect(body.servers).toHaveLength(1);
    expect(body.servers[0].name).toBe("Bazzite");
    expect(body.servers[0].gameCount).toBe(24);
    expect(body.servers[0].role).toBe("admin");
    expect(body.servers[0].lastSeenAt).toBe("2026-07-13T12:00:00.000Z");
    expect(body.library.totalGames).toBe(24);
    expect(body.library.pinnedCount).toBe(2);
    expect(typeof body.ice.stunConfigured).toBe("boolean");
  });
});

describe.each([
  ["favorites", () => import("@/app/api/favorites/route")],
  ["recent-plays", () => import("@/app/api/recent-plays/route")],
] as const)("GET /api/%s paginated search", (endpoint, loadRoute) => {
  it("filters by game name before pagination and reports the filtered total", async () => {
    const membershipsQuery = mockQueryBuilder([{ serverId: "server-1" }]);
    const countQuery = mockQueryBuilder([{ count: 1 }]);
    const pageQuery = mockQueryBuilder([{ id: "mario", name: "Super Mario", platform: "SNES", maxPlayers: 2 }]);
    mockDb.select
      .mockReturnValueOnce(membershipsQuery)
      .mockReturnValueOnce(countQuery)
      .mockReturnValueOnce(pageQuery);
    mockDb.selectDistinct.mockReturnValueOnce(pageQuery);

    const { GET } = await loadRoute();
    const resp = await GET(mkReq(`http://localhost/api/${endpoint}?limit=1&offset=1&search=mArIo`));
    const body = await resp.json();

    expect(body).toEqual({
      games: [{ id: "mario", name: "Super Mario", platform: "SNES", maxPlayers: 2 }],
      total: 1,
    });
    expect(pageQuery.limit).toHaveBeenCalledWith(1);
    expect(pageQuery.offset).toHaveBeenCalledWith(1);
    for (const query of [countQuery, pageQuery]) {
      expect(collectQueryValues(query.where.mock.calls[0][0])).toContain("%mArIo%");
    }
  });
});

describe("GET /api/recent-plays deterministic pagination", () => {
  it("groups games and uses a stable secondary order", async () => {
    const membershipsQuery = mockQueryBuilder([{ serverId: "server-1" }]);
    const countQuery = mockQueryBuilder([{ count: 2 }]);
    const pageQuery = mockQueryBuilder([]);
    mockDb.select
      .mockReturnValueOnce(membershipsQuery)
      .mockReturnValueOnce(countQuery)
      .mockReturnValueOnce(pageQuery);

    const { GET } = await import("@/app/api/recent-plays/route");
    await GET(mkReq("http://localhost/api/recent-plays?limit=1&offset=1"));

    expect(pageQuery.groupBy).toHaveBeenCalledTimes(1);
    expect(pageQuery.orderBy).toHaveBeenCalledTimes(1);
    const [primaryOrder, secondaryOrder] = pageQuery.orderBy.mock.calls[0];
    const { games, recentPlays } = await import("@/lib/db/schema");
    const sqlParts = (expression: unknown): unknown[] => {
      if (!expression || typeof expression !== "object") return [];
      const chunks = (expression as { queryChunks?: unknown[] }).queryChunks;
      if (!chunks) return [expression];
      return chunks.flatMap((chunk) => {
        const values = (chunk as { value?: string[] }).value;
        return values ? values : sqlParts(chunk);
      });
    };
    const primaryParts = sqlParts(primaryOrder);
    const secondaryParts = sqlParts(secondaryOrder);
    expect(primaryParts).toContain(recentPlays.playedAt);
    expect(primaryParts.filter((part): part is string => typeof part === "string").join(""))
      .toMatch(/max\(.*\).*desc/);
    expect(secondaryParts).toContain(games.id);
    expect(secondaryParts.filter((part): part is string => typeof part === "string").join(""))
      .toMatch(/asc/);
    expect(pageQuery.limit).toHaveBeenCalledWith(1);
    expect(pageQuery.offset).toHaveBeenCalledWith(1);
  });

  it("selects and returns the latest playedAt for each grouped game", async () => {
    const membershipsQuery = mockQueryBuilder([{ serverId: "server-1" }]);
    const countQuery = mockQueryBuilder([{ count: 1 }]);
    const pageQuery = mockQueryBuilder([{ id: "mario", playedAt: "2026-07-11T10:00:00.000Z" }]);
    mockDb.select
      .mockReturnValueOnce(membershipsQuery)
      .mockReturnValueOnce(countQuery)
      .mockReturnValueOnce(pageQuery);

    const { GET } = await import("@/app/api/recent-plays/route");
    const response = await GET(mkReq("http://localhost/api/recent-plays"));

    expect(await response.json()).toEqual({
      games: [{ id: "mario", playedAt: "2026-07-11T10:00:00.000Z" }],
      total: 1,
    });
    expect(mockDb.select.mock.calls[2][0]).toHaveProperty("playedAt");
  });
});
