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
import { mkdtempSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

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
    onConflictDoUpdate: vi.fn().mockReturnThis(),
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

// TURN probe mock — health tests control the relay probe result directly.
const mockRunTurnProbe = vi.fn();
vi.mock("@/lib/turn-probe", () => ({
  runTurnProbe: (...args: unknown[]) => mockRunTurnProbe(...args),
}));

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

// ── /api/auth/signup ───────────────────────────────────────────────────

describe("POST /api/auth/signup", () => {
  it("fails closed because enrollment requires an invite code", async () => {
    const { POST } = await import("@/app/api/auth/signup/route");
    const resp = await POST(mkReq("http://localhost/api/auth/signup", {
      ...jsonBody({ email: "new@example.com", password: "password" }),
    }));

    expect(resp.status).toBe(410);
    expect(await resp.json()).toEqual({
      error: "Open enrollment is disabled. Use an invitation link.",
    });
    expect(mockDb.insert).not.toHaveBeenCalled();
  });
});

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
      ...jsonBodyWithCsrf({ server_id: "server-1", type: "start_game", payload: { game_id: "local_0123456789abcdef0123456789abcdef" } }),
    });
    const resp = await POST(req as any);
    expect(resp.status).toBe(401);
  });

  it("rejects an unauthenticated SDP offer without a validated bearer token", async () => {
    mockAuth.mockResolvedValueOnce(null);
    const { POST } = await import("@/app/api/server/command/route");
    const req = mkReq("http://localhost/api/server/command", {
      ...jsonBody({
        server_id: "server-1",
        type: "sdp_offer",
        payload: {
          game_id: "local_0123456789abcdef0123456789abcdef",
          sdp: "v=0\r\n",
        },
      }),
    });

    const resp = await POST(req as any);

    expect(resp.status).toBe(401);
    expect(mockDb.insert).not.toHaveBeenCalled();
  });

  it("rejects a room-token SDP offer for a different game", async () => {
    mockAuth.mockResolvedValueOnce(null);
    mockDb.select.mockReturnValueOnce(mockQueryBuilder([{
      serverId: "server-1",
      gameId: "local_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      status: "ready",
    }]));
    const { POST } = await import("@/app/api/server/command/route");
    const req = mkReq("http://localhost/api/server/command", {
      ...jsonBody({
        server_id: "server-1",
        type: "sdp_offer",
        payload: {
          game_id: "local_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          room_token: "room-token",
          sdp: "v=0\r\n",
        },
      }),
    });

    const resp = await POST(req as any);

    expect(resp.status).toBe(403);
    expect(mockDb.insert).not.toHaveBeenCalled();
  });

  it("rejects a room-token SDP offer without an exact session peer token", async () => {
    mockAuth.mockResolvedValueOnce(null);
    mockDb.select.mockReturnValueOnce(mockQueryBuilder([{
      id: "session-1",
      serverId: "server-1",
      gameId: "local_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      status: "ready",
    }]));
    const { POST } = await import("@/app/api/server/command/route");
    const req = mkReq("http://localhost/api/server/command", {
      ...jsonBody({
        server_id: "server-1",
        type: "sdp_offer",
        payload: {
          game_id: "local_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          room_token: "room-token",
          sdp: "v=0\r\n",
        },
      }),
    });

    const resp = await POST(req as any);

    expect(resp.status).toBe(403);
    expect(mockDb.insert).not.toHaveBeenCalled();
  });

  it("rejects a peer token issued for another room session", async () => {
    mockAuth.mockResolvedValueOnce(null);
    mockDb.select
      .mockReturnValueOnce(mockQueryBuilder([{
        id: "session-1",
        serverId: "server-1",
        gameId: "local_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        status: "ready",
      }]))
      .mockReturnValueOnce(mockQueryBuilder([]));
    const { POST } = await import("@/app/api/server/command/route");
    const req = mkReq("http://localhost/api/server/command", {
      ...jsonBody({
        server_id: "server-1",
        type: "sdp_offer",
        payload: {
          game_id: "local_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          room_token: "room-token",
          peer_token: "peer-from-another-session",
          sdp: "v=0\r\n",
        },
      }),
    });

    const resp = await POST(req as any);

    expect(resp.status).toBe(403);
    expect(mockDb.insert).not.toHaveBeenCalled();
  });

  it("rejects guest SDP for a timed-out room session even with its peer token", async () => {
    mockAuth.mockResolvedValueOnce(null);
    mockDb.select
      .mockReturnValueOnce(mockQueryBuilder([{
        id: "session-timed-out",
        serverId: "server-1",
        gameId: "local_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        status: "timed_out",
      }]))
      .mockReturnValueOnce(mockQueryBuilder([{ role: "player", seat: 1 }]));
    const { POST } = await import("@/app/api/server/command/route");
    const req = mkReq("http://localhost/api/server/command", {
      ...jsonBody({
        server_id: "server-1",
        type: "sdp_offer",
        payload: {
          game_id: "local_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          room_token: "expired-room",
          peer_token: "expired-peer",
          sdp: "v=0\r\n",
        },
      }),
    });

    const resp = await POST(req as any);

    expect(resp.status).toBe(410);
    expect(mockDb.insert).not.toHaveBeenCalled();
  });

  it("accepts and enriches a peer token bound to the exact room session", async () => {
    mockAuth.mockResolvedValueOnce(null);
    mockDb.select
      .mockReturnValueOnce(mockQueryBuilder([{
        id: "session-1",
        serverId: "server-1",
        gameId: "local_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        status: "ready",
      }]))
      .mockReturnValueOnce(mockQueryBuilder([{ role: "player", seat: 2 }]));
    const { POST } = await import("@/app/api/server/command/route");
    const req = mkReq("http://localhost/api/server/command", {
      ...jsonBody({
        server_id: "server-1",
        type: "sdp_offer",
        payload: {
          game_id: "local_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          room_token: "room-token",
          peer_token: "peer-for-session-1",
          sdp: "v=0\r\n",
        },
      }),
    });

    const resp = await POST(req as any);

    expect(resp.status).toBe(201);
    const insertBuilder = mockDb.insert.mock.results[0].value;
    expect(insertBuilder.values).toHaveBeenCalledWith(expect.objectContaining({
      serverId: "server-1",
      payload: expect.objectContaining({
        peer_role: "player",
        peer_seat: 2,
        session_id: "session-1",
      }),
    }));
  });

  it("propagates viewer authority from the exact peer token", async () => {
    mockAuth.mockResolvedValueOnce(null);
    mockDb.select
      .mockReturnValueOnce(mockQueryBuilder([{
        id: "session-1",
        serverId: "server-1",
        gameId: "local_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        status: "playing",
      }]))
      .mockReturnValueOnce(mockQueryBuilder([{ role: "viewer", seat: 4 }]));
    const { POST } = await import("@/app/api/server/command/route");
    const req = mkReq("http://localhost/api/server/command", {
      ...jsonBody({
        server_id: "server-1",
        type: "sdp_offer",
        payload: {
          game_id: "local_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          room_token: "room-token",
          peer_token: "viewer-peer-for-session-1",
          sdp: "v=0\r\n",
        },
      }),
    });

    const resp = await POST(req as any);

    expect(resp.status).toBe(201);
    const insertBuilder = mockDb.insert.mock.results[0].value;
    expect(insertBuilder.values).toHaveBeenCalledWith(expect.objectContaining({
      payload: expect.objectContaining({
        peer_role: "viewer",
        peer_seat: 4,
        session_id: "session-1",
      }),
    }));
  });

  it("does not let a host capability bypass guest peer binding", async () => {
    mockAuth.mockResolvedValueOnce(null);
    mockDb.select
      .mockReturnValueOnce(mockQueryBuilder([{
        id: "session-1",
        serverId: "server-1",
        gameId: "local_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        status: "ready",
      }]))
      .mockReturnValueOnce(mockQueryBuilder([]));
    const { POST } = await import("@/app/api/server/command/route");
    const req = mkReq("http://localhost/api/server/command", {
      ...jsonBody({
        server_id: "server-1",
        type: "sdp_offer",
        payload: {
          game_id: "local_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          room_token: "room-token",
          peer_token: "arbitrary-peer",
          host_token: "valid-host-token",
          sdp: "v=0\r\n",
        },
      }),
    });

    const resp = await POST(req as any);

    expect(resp.status).toBe(403);
    expect(mockDb.select.mock.calls[0][0]).toHaveProperty("id");
    expect(mockDb.select.mock.calls[0][0]).not.toHaveProperty("code");
    expect(mockDb.insert).not.toHaveBeenCalled();
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
      ...jsonBody({ server_id: "server-1", type: "stop_game", payload: { game_id: "local_0123456789abcdef0123456789abcdef" } }),
    });
    const resp = await POST(req as any);
    expect(resp.status).toBe(403);
    const body = await resp.json();
    expect(body.error).toContain("csrf");
  });

  it("binds stop commands to the exact active session generation", async () => {
    mockDb.select
      .mockReturnValueOnce(mockQueryBuilder([{ role: "admin" }]))
      .mockReturnValueOnce(mockQueryBuilder([{ id: "session-current" }]));
    const { POST } = await import("@/app/api/server/command/route");
    const req = mkReq("http://localhost/api/server/command", {
      ...jsonBodyWithCsrf({
        server_id: "server-1",
        type: "stop_game",
        payload: { game_id: "local_0123456789abcdef0123456789abcdef" },
      }),
    });

    const resp = await POST(req as any);

    expect(resp.status).toBe(201);
    const insertBuilder = mockDb.insert.mock.results[0].value;
    expect(insertBuilder.values).toHaveBeenCalledWith(expect.objectContaining({
      type: "stop_game",
      payload: expect.objectContaining({ session_id: "session-current" }),
    }));
  });

  it("allows a LAN host capability to stop only its exact active session", async () => {
    mockAuth.mockResolvedValueOnce(null);
    mockDb.select
      .mockReturnValueOnce(mockQueryBuilder([{ code: "ABC123" }]))
      .mockReturnValueOnce(mockQueryBuilder([{ userId: "owner-1" }]))
      .mockReturnValueOnce(mockQueryBuilder([{ id: "session-lan" }]));
    const { POST } = await import("@/app/api/server/command/route");
    const req = mkReq("http://localhost/api/server/command", {
      ...jsonBody({
        server_id: "server-1",
        type: "stop_game",
        payload: {
          game_id: "local_0123456789abcdef0123456789abcdef",
          host_token: "host-lan",
        },
      }),
    });

    const resp = await POST(req as any);

    expect(resp.status).toBe(201);
    const insertBuilder = mockDb.insert.mock.results[0].value;
    expect(insertBuilder.values).toHaveBeenCalledWith(expect.objectContaining({
      payload: expect.objectContaining({
        host_token: "host-lan",
        session_id: "session-lan",
      }),
    }));
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
        payload: { game_id: "local_0123456789abcdef0123456789abcdef", sdp: "v=0\r\n", unexpected: true },
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
      .mockReturnValueOnce(mockQueryBuilder([]))
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
      ...jsonBodyWithCsrf({ server_id: "server-1", type: "start_game", payload: { game_id: "local_0123456789abcdef0123456789abcdef" } }),
    });
    const resp = await POST(req as any);
    expect(resp.status).toBe(201);
    const body = await resp.json();
    expect(body.worker_token).toBeTruthy();
    expect(body.worker_token.length).toBe(32);

    expect(mockDb.insert).toHaveBeenCalledWith(launchEvents);
  });

  it("queues start_game for an enrolled member who created the host launch code", async () => {
    mockDb.select
      .mockReturnValueOnce(mockQueryBuilder([{ role: "member" }]))
      .mockReturnValueOnce(mockQueryBuilder([{ createdBy: "user-1" }]))
      .mockReturnValueOnce(mockQueryBuilder([]))
      .mockReturnValueOnce(mockQueryBuilder([]));

    const { launchEvents, commands: commandsTable, sessions: sessionsTable, peerTokens: peerTokensTable } = await import("@/lib/db/schema");
    const commandInsertBuilder = {
      values: vi.fn().mockReturnThis(),
      returning: vi.fn(() => Promise.resolve([{ id: "cmd-member" }])),
    };
    const sessionInsertBuilder = {
      values: vi.fn().mockReturnThis(),
      returning: vi.fn(() => Promise.resolve([{ id: "sess-member" }])),
    };
    const peerTokenInsertBuilder = {
      values: vi.fn().mockReturnThis(),
      returning: vi.fn(() => Promise.resolve([])),
    };
    mockDb.insert.mockImplementation((table: unknown) => {
      if (table === commandsTable) return commandInsertBuilder;
      if (table === launchEvents) return mockQueryBuilder([{ id: "launch-member" }]);
      if (table === sessionsTable) return sessionInsertBuilder;
      if (table === peerTokensTable) return peerTokenInsertBuilder;
      return mockQueryBuilder([{ id: "fallback" }]);
    });
    mockDb.update.mockReturnValue({
      set: vi.fn(() => ({ where: vi.fn(() => Promise.resolve(undefined)) })),
    });

    const { POST } = await import("@/app/api/server/command/route");
    const req = mkReq("http://localhost/api/server/command", {
      ...jsonBodyWithCsrf({
        server_id: "server-1",
        type: "start_game",
        payload: {
          game_id: "local_0123456789abcdef0123456789abcdef",
          host_token: "member-host-token",
        },
      }),
    });
    const resp = await POST(req as any);
    expect(resp.status).toBe(201);
    expect(sessionInsertBuilder.values).toHaveBeenCalledWith(expect.objectContaining({
      userId: "user-1",
      hostToken: "member-host-token",
    }));
  });

  it("rejects start_game when a member did not create the host launch code", async () => {
    mockDb.select
      .mockReturnValueOnce(mockQueryBuilder([{ role: "member" }]))
      .mockReturnValueOnce(mockQueryBuilder([]));
    const { POST } = await import("@/app/api/server/command/route");
    const req = mkReq("http://localhost/api/server/command", {
      ...jsonBodyWithCsrf({
        server_id: "server-1",
        type: "start_game",
        payload: {
          game_id: "local_0123456789abcdef0123456789abcdef",
          host_token: "another-members-token",
        },
      }),
    });
    const resp = await POST(req as any);
    expect(resp.status).toBe(403);
    expect(await resp.json()).toMatchObject({ error: "host authority required" });
  });

  it("rejects stop_game from a viewer (non-admin) member", async () => {
    mockDb.select.mockReturnValueOnce(mockQueryBuilder([{ role: "viewer" }]));
    const { POST } = await import("@/app/api/server/command/route");
    const req = mkReq("http://localhost/api/server/command", {
      ...jsonBodyWithCsrf({ server_id: "server-1", type: "stop_game", payload: { game_id: "local_0123456789abcdef0123456789abcdef" } }),
    });
    const resp = await POST(req as any);
    expect(resp.status).toBe(403);
    expect(await resp.json()).toMatchObject({ error: "host authority required" });
  });

  it("queues a server-local opaque game without querying legacy game files", async () => {
    const gameId = "local_0123456789abcdef0123456789abcdef";
    mockDb.select
      .mockReturnValueOnce(mockQueryBuilder([{ role: "admin" }]))
      .mockReturnValueOnce(mockQueryBuilder([]));

    const { launchEvents, commands: commandsTable, sessions: sessionsTable, peerTokens: peerTokensTable } = await import("@/lib/db/schema");
    const commandInsertBuilder = {
      values: vi.fn().mockReturnThis(),
      returning: vi.fn(() => Promise.resolve([{ id: "cmd-local" }])),
    };
    mockDb.insert.mockImplementation((table: unknown) => {
      if (table === commandsTable) return commandInsertBuilder;
      if (table === sessionsTable) return { values: vi.fn().mockReturnThis(), returning: vi.fn(() => Promise.resolve([{ id: "sess-local" }])) };
      if (table === peerTokensTable) return { values: vi.fn().mockReturnThis(), returning: vi.fn(() => Promise.resolve([])) };
      if (table === launchEvents) return mockQueryBuilder([{ id: "launch-local" }]);
      return mockQueryBuilder([{ id: "fallback" }]);
    });
    const updateSet = vi.fn(() => ({ where: vi.fn(() => Promise.resolve(undefined)) }));
    mockDb.update.mockReturnValue({ set: updateSet });

    const { POST } = await import("@/app/api/server/command/route");
    const req = mkReq("http://localhost/api/server/command", {
      ...jsonBodyWithCsrf({ server_id: "server-1", type: "start_game", payload: { game_id: gameId } }),
    });
    const resp = await POST(req as any);

    expect(resp.status).toBe(201);
    expect(commandInsertBuilder.values).toHaveBeenCalledWith(expect.objectContaining({
      payload: { game_id: gameId },
      status: "preparing",
    }));
    expect(updateSet).toHaveBeenCalledWith(expect.objectContaining({
      status: "pending",
      payload: expect.objectContaining({
        game_id: gameId,
        session_id: "sess-local",
        peer_tokens: [expect.objectContaining({ role: "host", seat: 0 })],
      }),
    }));
  });

  it("attributes a LAN member launch to the member who created its short code", async () => {
    mockAuth.mockResolvedValueOnce(null);
    mockDb.select
      .mockReturnValueOnce(mockQueryBuilder([{ code: "ABC123", createdBy: "member-user" }]))
      .mockReturnValueOnce(mockQueryBuilder([{ userId: "member-user" }]))
      .mockReturnValueOnce(mockQueryBuilder([]));

    const { launchEvents, commands: commandsTable, sessions: sessionsTable, peerTokens: peerTokensTable, shortCodes: shortCodesTable } = await import("@/lib/db/schema");
    const sessionValues = vi.fn().mockReturnThis();
    mockDb.insert.mockImplementation((table: unknown) => {
      if (table === commandsTable) return { values: vi.fn().mockReturnThis(), returning: vi.fn(() => Promise.resolve([{ id: "cmd-lan" }])) };
      if (table === sessionsTable) return { values: sessionValues, returning: vi.fn(() => Promise.resolve([{ id: "sess-lan" }])) };
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
      payload: { game_id: "local_0123456789abcdef0123456789abcdef", host_token: "host-secret", lan: true, sdp: "v=0\r\n" },
    }));

    const resp = await POST(req as any);
    expect(resp.status).toBe(201);
    const body = await resp.json();
    expect(body.sdp_answer).toBe("v=0\r\nanswer");
    expect(mockDb.select).toHaveBeenNthCalledWith(1, {
      code: shortCodesTable.code,
      createdBy: shortCodesTable.createdBy,
      mintedViaProxy: shortCodesTable.mintedViaProxy,
    });
    expect(sessionValues).toHaveBeenCalledWith(expect.objectContaining({
      userId: "member-user",
    }));
  });

  it("fails closed for a fresh LAN start using a legacy code without a creator", async () => {
    mockAuth.mockResolvedValueOnce(null);
    // No bearer presented (or bearer does not match) — creator-less legacy
    // codes cannot authorize a fresh start on their own.
    mockVerifyBearerToken.mockReset().mockResolvedValueOnce(null).mockResolvedValue({ id: "server-1", userId: "user-1", name: "sc-server", apiKeyHash: "hashed_key" });
    mockDb.select
      .mockReturnValueOnce(mockQueryBuilder([{ code: "LEGACY", createdBy: null, mintedViaProxy: false }]))
      .mockReturnValueOnce(mockQueryBuilder([]));

    const { POST } = await import("@/app/api/server/command/route");
    const req = mkReq("http://localhost/api/server/command", {
      ...jsonBody({
        server_id: "server-1",
        type: "start_game",
        payload: {
          game_id: "local_0123456789abcdef0123456789abcdef",
          host_token: "legacy-host-token",
          lan: true,
        },
      }),
    });

    const resp = await POST(req as any);

    expect(resp.status).toBe(403);
  });

  it("authorizes a creator-less LAN code when the paired server bearer matches (LAN proxy)", async () => {
    // The LAN player's start_game is proxied by sc-server with the server
    // bearer. A code minted through that same proxy has createdBy = NULL,
    // mintedViaProxy = true; the paired server bearer is the host authority
    // for its own LAN.
    mockAuth.mockResolvedValueOnce(null);
    mockDb.select
      .mockReturnValueOnce(mockQueryBuilder([{ code: "LANPROXY", createdBy: null, mintedViaProxy: true }]))
      .mockReturnValueOnce(mockQueryBuilder([]))   // legacy session lookup: none
      .mockReturnValueOnce(mockQueryBuilder([{ userId: "owner-user" }])); // serverMembers check
    mockVerifyBearerToken.mockReset().mockResolvedValueOnce({ id: "server-1", userId: "owner-user" }).mockResolvedValue({ id: "server-1", userId: "user-1", name: "sc-server", apiKeyHash: "hashed_key" });

    const { launchEvents, commands: commandsTable, sessions: sessionsTable, peerTokens: peerTokensTable } = await import("@/lib/db/schema");
    const sessionValues = vi.fn().mockReturnThis();
    mockDb.insert.mockImplementation((table: unknown) => {
      if (table === commandsTable) return { values: vi.fn().mockReturnThis(), returning: vi.fn(() => Promise.resolve([{ id: "cmd-lanproxy" }])) };
      if (table === sessionsTable) return { values: sessionValues, returning: vi.fn(() => Promise.resolve([{ id: "sess-lanproxy" }])) };
      if (table === peerTokensTable) return { values: vi.fn().mockReturnThis(), returning: vi.fn(() => Promise.resolve([])) };
      if (table === launchEvents) return mockQueryBuilder([{ id: "launch-lanproxy" }]);
      return mockQueryBuilder([{ id: "fallback" }]);
    });
    mockDb.update.mockReturnValue({ set: vi.fn(() => ({ where: vi.fn(() => Promise.resolve(undefined)) })) });
    mockWaitForSdpAnswer.mockResolvedValueOnce("v=0\r\nanswer");

    const { POST } = await import("@/app/api/server/command/route");
    const req = mkReq("http://localhost/api/server/command", {
      method: "POST",
      headers: { ...jsonBody({}).headers, ...authHeader("scsk_test_api_key_12345") },
      body: JSON.stringify({
        server_id: "server-1",
        type: "start_game",
        payload: {
          game_id: "local_0123456789abcdef0123456789abcdef",
          host_token: "proxy-minted-token",
          lan: true,
          sdp: "v=0\r\n",
        },
      }),
    });

    const resp = await POST(req as any);
    expect(resp.status).toBe(201);
    expect(sessionValues).toHaveBeenCalledWith(expect.objectContaining({
      userId: "owner-user",
    }));
  });

  it("keeps failing closed when the bearer does not match the target server", async () => {
    mockAuth.mockResolvedValueOnce(null);
    mockDb.select
      .mockReturnValueOnce(mockQueryBuilder([{ code: "LANPROXY", createdBy: null, mintedViaProxy: true }]))
      .mockReturnValueOnce(mockQueryBuilder([]))   // legacy session lookup: none
      .mockReturnValueOnce(mockQueryBuilder([]));  // membership lookup
    // Bearer belongs to a DIFFERENT server — not host authority here.
    mockVerifyBearerToken.mockReset().mockResolvedValueOnce({ id: "server-other", userId: "other-user" }).mockResolvedValue({ id: "server-1", userId: "user-1", name: "sc-server", apiKeyHash: "hashed_key" });

    const { POST } = await import("@/app/api/server/command/route");
    const req = mkReq("http://localhost/api/server/command", {
      method: "POST",
      headers: { ...jsonBody({}).headers, ...authHeader("scsk_test_api_key_12345") },
      body: JSON.stringify({
        server_id: "server-1",
        type: "start_game",
        payload: {
          game_id: "local_0123456789abcdef0123456789abcdef",
          host_token: "proxy-minted-token",
          lan: true,
        },
      }),
    });

    const resp = await POST(req as any);
    expect(resp.status).toBe(403);
    expect(await resp.json()).toMatchObject({ error: "invalid LAN launch token" });
  });

  it("authorizes a proxy-minted LAN stop_game via server bearer", async () => {
    mockAuth.mockResolvedValueOnce(null);
    mockDb.select
      .mockReturnValueOnce(mockQueryBuilder([{ code: "LANSTOP", createdBy: null, mintedViaProxy: true }]))
      .mockReturnValueOnce(mockQueryBuilder([]))   // legacy session: none
      .mockReturnValueOnce(mockQueryBuilder([{ userId: "owner-user" }])); // serverMembers
    mockVerifyBearerToken.mockReset().mockResolvedValueOnce({ id: "server-1", userId: "owner-user" }).mockResolvedValue({ id: "server-1", userId: "user-1", name: "sc-server", apiKeyHash: "hashed_key" });

    // stop_game needs an active session to resolve session_id
    mockDb.select
      .mockReturnValueOnce(mockQueryBuilder([{ id: "sess-lanstop" }])); // active session lookup

    const { commands: commandsTable } = await import("@/lib/db/schema");
    mockDb.insert.mockReturnValue({ values: vi.fn().mockReturnThis(), returning: vi.fn(() => Promise.resolve([{ id: "cmd-lanstop" }])) });

    const { POST } = await import("@/app/api/server/command/route");
    const req = mkReq("http://localhost/api/server/command", {
      method: "POST",
      headers: { ...jsonBody({}).headers, ...authHeader("scsk_test_api_key_12345") },
      body: JSON.stringify({
        server_id: "server-1",
        type: "stop_game",
        payload: {
          game_id: "local_0123456789abcdef0123456789abcdef",
          host_token: "proxy-minted-token",
        },
      }),
    });

    const resp = await POST(req as any);
    expect(resp.status).toBe(201);
  });

  it("authorizes a proxy-minted LAN sdp_offer via server bearer", async () => {
    mockAuth.mockResolvedValueOnce(null);
    mockDb.select
      .mockReturnValueOnce(mockQueryBuilder([{ code: "LANSDP", createdBy: null, mintedViaProxy: true }]))
      .mockReturnValueOnce(mockQueryBuilder([]))   // legacy session: none
      .mockReturnValueOnce(mockQueryBuilder([{ userId: "owner-user" }])); // serverMembers
    mockVerifyBearerToken.mockReset().mockResolvedValueOnce({ id: "server-1", userId: "owner-user" }).mockResolvedValue({ id: "server-1", userId: "user-1", name: "sc-server", apiKeyHash: "hashed_key" });

    // sdp_offer host reconnect needs an active session
    mockDb.select
      .mockReturnValueOnce(mockQueryBuilder([{ id: "sess-lansdp" }])); // host session lookup

    const { commands: commandsTable } = await import("@/lib/db/schema");
    mockDb.insert.mockReturnValue({ values: vi.fn().mockReturnThis(), returning: vi.fn(() => Promise.resolve([{ id: "cmd-lansdp" }])) });

    const { POST } = await import("@/app/api/server/command/route");
    const req = mkReq("http://localhost/api/server/command", {
      method: "POST",
      headers: { ...jsonBody({}).headers, ...authHeader("scsk_test_api_key_12345") },
      body: JSON.stringify({
        server_id: "server-1",
        type: "sdp_offer",
        payload: {
          game_id: "local_0123456789abcdef0123456789abcdef",
          host_token: "proxy-minted-token",
          sdp: "v=0\r\n",
        },
      }),
    });

    const resp = await POST(req as any);
    expect(resp.status).toBe(201);
  });

  it("rejects bearer override for legacy codes not minted via proxy", async () => {
    // A code with createdBy = NULL but mintedViaProxy = false (legacy or
    // browser-minted) must NOT grant authority to the server bearer.
    mockAuth.mockResolvedValueOnce(null);
    mockDb.select
      .mockReturnValueOnce(mockQueryBuilder([{ code: "LEGACY2", createdBy: null, mintedViaProxy: false }]))
      .mockReturnValueOnce(mockQueryBuilder([]));  // legacy session: none
    // verifyBearerToken should NOT be called — bearer override is gated
    mockVerifyBearerToken.mockReset().mockResolvedValueOnce({ id: "server-1", userId: "owner-user" }).mockResolvedValue({ id: "server-1", userId: "user-1", name: "sc-server", apiKeyHash: "hashed_key" });

    const { POST } = await import("@/app/api/server/command/route");
    const req = mkReq("http://localhost/api/server/command", {
      method: "POST",
      headers: { ...jsonBody({}).headers, ...authHeader("scsk_test_api_key_12345") },
      body: JSON.stringify({
        server_id: "server-1",
        type: "start_game",
        payload: {
          game_id: "local_0123456789abcdef0123456789abcdef",
          host_token: "legacy-token",
          lan: true,
        },
      }),
    });

    const resp = await POST(req as any);
    expect(resp.status).toBe(403);
    expect(await resp.json()).toMatchObject({ error: "invalid LAN launch token" });
  });

  it("rejects a private room capability used as a LAN host token", async () => {
    mockAuth.mockResolvedValueOnce(null);
    const { POST } = await import("@/app/api/server/command/route");
    const req = mkReq("http://localhost/api/server/command", jsonBody({
      server_id: "server-1",
      type: "start_game",
      payload: {
        game_id: "local_0123456789abcdef0123456789abcdef",
        host_token: "a".repeat(32),
        lan: true,
      },
    }));

    const resp = await POST(req as any);
    expect(resp.status).toBe(403);
    expect(await resp.json()).toMatchObject({
      error: "room capability cannot authorize host actions",
    });
    expect(mockDb.insert).not.toHaveBeenCalled();
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
      .mockReturnValueOnce(mockQueryBuilder([]))
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
      ...jsonBodyWithCsrf({ server_id: "server-1", type: "start_game", payload: { game_id: "local_0123456789abcdef0123456789abcdef" } }),
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
    expect(insertedValues[0]?.payload).toMatchObject({ game_id: "local_0123456789abcdef0123456789abcdef" });
    expect((insertedValues[0]?.payload as Record<string, unknown>).lan).toBeUndefined();

    if (prevLanIps !== undefined) process.env.GV_SERVER_LAN_IPS = prevLanIps;
    else delete process.env.GV_SERVER_LAN_IPS;
  });

  it("attaches the authenticated user_id to the start_game payload (#745)", async () => {
    // The gateway enriches the final start_game payload with the session
    // owner's user_id — sc-server attributes artifacts to this account.
    const { launchEvents, commands: commandsTable, sessions: sessionsTable, peerTokens: peerTokensTable } = await import("@/lib/db/schema");

    const commandUpdates: Array<Record<string, unknown>> = [];
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
      .mockReturnValue(mockQueryBuilder([]));
    mockDb.insert.mockImplementation((table: unknown) => {
      if (table === commandsTable) return { values: vi.fn().mockReturnThis(), returning: vi.fn(() => Promise.resolve([{ id: "cmd-123" }])) };
      if (table === launchEvents) return mockQueryBuilder([{ id: "launch-1" }]);
      if (table === sessionsTable) return { values: vi.fn().mockReturnThis(), returning: vi.fn(() => Promise.resolve([{ id: "sess-123" }])) };
      if (table === peerTokensTable) return { values: vi.fn().mockReturnThis(), returning: vi.fn(() => Promise.resolve([])) };
      return mockQueryBuilder([{ id: "fallback" }]);
    });
    mockDb.update.mockImplementation(() => ({
      set: vi.fn((value: Record<string, unknown>) => {
        commandUpdates.push(value);
        return { where: vi.fn(() => Promise.resolve(undefined)) };
      }),
    }));

    const { POST } = await import("@/app/api/server/command/route");
    const req = mkReq("http://localhost/api/server/command", {
      ...jsonBodyWithCsrf({ server_id: "server-1", type: "start_game", payload: { game_id: "local_0123456789abcdef0123456789abcdef" } }),
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

    // The payload update that publishes the session (finalPayload) must
    // carry user_id — the server's authoritative identity source.
    const finalPayload = commandUpdates
      .map((u) => u.payload as Record<string, unknown>)
      .find((p) => p.session_id === "sess-123");
    expect(finalPayload?.user_id).toBe("user-1");
  });

  it("keeps stale reconnect candidates active for transactional replacement", async () => {
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
        payload: { game_id: "local_0123456789abcdef0123456789abcdef", sdp: "v=0\r\n" },
      }),
    });
    const resp = await POST(req as any);
    expect(resp.status).toBe(201);
    const body = await resp.json();
    expect(body.host_peer_token).toBeTruthy();
    expect(sessionUpdates).not.toContainEqual(expect.objectContaining({ status: "timed_out" }));
    expect(mockDb.insert).toHaveBeenCalledWith(sessionsTable);
  });
});

// ── /api/room/shorten ─────────────────────────────────────────────────

describe("POST /api/room/shorten", () => {
  const body = {
    game_id: "local_0123456789abcdef0123456789abcdef",
    host_token: "host-token",
    server_id: "server-1",
  };

  it("rejects unauthenticated callers without a server bearer token", async () => {
    mockAuth.mockResolvedValueOnce(null);
    mockVerifyBearerToken.mockReset().mockResolvedValueOnce(null).mockResolvedValue({ id: "server-1", userId: "user-1", name: "sc-server", apiKeyHash: "hashed_key" });
    const { POST } = await import("@/app/api/room/shorten/route");

    const resp = await POST(mkReq("http://localhost/api/room/shorten", jsonBody(body)));

    expect(resp.status).toBe(401);
    expect(mockDb.insert).not.toHaveBeenCalled();
  });

  it("accepts the owning sc-server bearer token", async () => {
    const { POST } = await import("@/app/api/room/shorten/route");

    const resp = await POST(mkReq("http://localhost/api/room/shorten", {
      ...jsonBody(body),
      headers: { ...jsonBody(body).headers, ...authHeader() },
    }));

    expect(resp.status).toBe(201);
    expect(mockVerifyBearerToken).toHaveBeenCalled();
  });

  it("binds private invite codes to the active room capability with 80 bits of entropy", async () => {
    const roomToken = "a".repeat(32);
    let inserted: Record<string, unknown> | undefined;
    mockDb.select
      .mockReturnValueOnce(mockQueryBuilder([{ role: "member" }]))
      .mockReturnValueOnce(mockQueryBuilder([{
        id: "session-1",
        roomToken,
        status: "playing",
      }]));
    mockDb.insert.mockReturnValueOnce({
      values: vi.fn((value: Record<string, unknown>) => {
        inserted = value;
        return Promise.resolve();
      }),
    });
    const { POST } = await import("@/app/api/room/shorten/route");
    const resp = await POST(mkReq("http://localhost/api/room/shorten", {
      ...jsonBody({
        game_id: "local_0123456789abcdef0123456789abcdef",
        room_token: roomToken,
        server_id: "server-1",
      }),
    }));
    const responseBody = await resp.json();

    expect(resp.status).toBe(201);
    expect(responseBody.code).toMatch(/^[A-HJ-NP-Z2-9]{16}$/);
    expect(inserted).toMatchObject({ hostToken: roomToken });
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

  it("creates a matching command before its foreign-keyed resident session", async () => {
    const gameId = "local_0123456789abcdef0123456789abcdef";
    mockDb.select
      .mockImplementationOnce(() => mockQueryBuilder([{ gameId, maxSeats: 2 }]))
      .mockImplementationOnce(() => mockQueryBuilder([]))
      .mockImplementation(() => mockQueryBuilder([]));

    const inserted: Array<{ table: unknown; values: Record<string, unknown> }> = [];
    mockDb.insert.mockImplementation((table: unknown) => ({
      values: vi.fn((values: Record<string, unknown>) => {
        inserted.push({ table, values });
        return Promise.resolve([]);
      }),
    }) as any);

    const { GET } = await import("@/app/api/server/poll/route");
    const req = mkReq("http://localhost/api/server/poll", {
      headers: authHeader(),
    });
    const resp = await GET(req);

    expect(resp.status).toBe(200);
    const sessionInsert = inserted.find(({ values }) => values.gameId === gameId);
    const commandInsert = inserted.find(({ values }) => values.type === "start_game");
    expect(inserted.indexOf(commandInsert!)).toBeLessThan(inserted.indexOf(sessionInsert!));
    expect(sessionInsert?.values).toMatchObject({
      id: expect.any(String),
      userId: "user-1",
      serverId: "server-1",
      gameId,
      commandId: expect.any(String),
      hostToken: expect.any(String),
      status: "spawning",
      maxSeats: 2,
    });
    expect(commandInsert?.values).toMatchObject({
      serverId: "server-1",
      type: "start_game",
      status: "pending",
      payload: {
        game_id: gameId,
        session_id: sessionInsert?.values.id,
        resident: true,
        max_seats: 2,
      },
    });
    expect(commandInsert?.values.commandId).toBeUndefined();
  });

  it("leases pending commands and returns lease metadata", async () => {
    const rows = [
      { id: "cmd-1", type: "start_game", payload: { game_id: "local_0123456789abcdef0123456789abcdef" }, attempts: 0 },
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
      payload: { game_id: "local_0123456789abcdef0123456789abcdef" },
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
      { id: "cmd-1", type: "sdp_offer", payload: { game_id: "local_0123456789abcdef0123456789abcdef" }, attempts: 0 },
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

// ── /api/servers/[server_id]/upgrade ──────────────────────────────────

describe("POST /api/servers/[server_id]/upgrade", () => {
  const params = { params: Promise.resolve({ server_id: "server-1" }) };
  const request = () => mkReq("http://localhost/api/servers/server-1/upgrade", jsonBodyWithCsrf({}));

  it("requires authentication", async () => {
    mockAuth.mockResolvedValueOnce(null);
    const { POST } = await import("@/app/api/servers/[server_id]/upgrade/route");
    expect((await POST(request(), params)).status).toBe(401);
  });

  it("requires a matching CSRF token", async () => {
    const { POST } = await import("@/app/api/servers/[server_id]/upgrade/route");
    const req = mkReq("http://localhost/api/servers/server-1/upgrade", { method: "POST" });
    expect((await POST(req, params)).status).toBe(403);
  });

  it("fails closed for non-members and non-admin members", async () => {
    const { POST } = await import("@/app/api/servers/[server_id]/upgrade/route");
    mockDb.select.mockReturnValueOnce(mockQueryBuilder([]));
    expect((await POST(request(), params)).status).toBe(404);

    mockDb.select.mockReturnValueOnce(mockQueryBuilder([{ role: "member" }]));
    expect((await POST(request(), params)).status).toBe(403);
  });

  it("queues an update for an administrator", async () => {
    mockDb.select
      .mockReturnValueOnce(mockQueryBuilder([{ role: "admin" }]))
      .mockReturnValueOnce(mockQueryBuilder([]));
    mockDb.insert.mockReturnValueOnce(mockQueryBuilder([{ id: "upgrade-1", status: "pending" }]));
    const { POST } = await import("@/app/api/servers/[server_id]/upgrade/route");
    const resp = await POST(request(), params);
    expect(resp.status).toBe(202);
    expect(await resp.json()).toEqual({ command_id: "upgrade-1", status: "pending" });
  });

  it("rejects an already-active update", async () => {
    mockDb.select
      .mockReturnValueOnce(mockQueryBuilder([{ role: "admin" }]))
      .mockReturnValueOnce(mockQueryBuilder([{ id: "upgrade-1", status: "leased" }]));
    const { POST } = await import("@/app/api/servers/[server_id]/upgrade/route");
    const resp = await POST(request(), params);
    expect(resp.status).toBe(409);
    expect(mockDb.insert).not.toHaveBeenCalled();
  });

  it("maps a concurrent unique-index loser to the winning command", async () => {
    mockDb.select
      .mockReturnValueOnce(mockQueryBuilder([{ role: "admin" }]))
      .mockReturnValueOnce(mockQueryBuilder([]))
      .mockReturnValueOnce(mockQueryBuilder([{ id: "upgrade-winner", status: "pending" }]));
    mockDb.insert.mockReturnValueOnce(mockQueryBuilder(Promise.reject(Object.assign(new Error("duplicate"), { code: "23505" }))));
    const { POST } = await import("@/app/api/servers/[server_id]/upgrade/route");
    const resp = await POST(request(), params);
    expect(resp.status).toBe(409);
    expect(await resp.json()).toMatchObject({ command_id: "upgrade-winner", status: "pending" });
  });
});

// ── /api/server/notify ─────────────────────────────────────────────────

describe("POST /api/server/notify", () => {
  it("returns 401 without bearer token", async () => {
    mockVerifyBearerToken.mockResolvedValueOnce(null);
    const { POST } = await import("@/app/api/server/notify/route");
    const req = mkReq("http://localhost/api/server/notify", {
      ...jsonBody({ command_id: "cmd-1", worker_url: "http://localhost:9999", game_id: "local_0123456789abcdef0123456789abcdef" }),
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


  it("accepts a ROM SDP answer without game-only fields", async () => {
    mockDb.select.mockReturnValueOnce(mockQueryBuilder([{
      id: "rom-command",
      serverId: "server-1",
      workerToken: null,
      type: "rom_transfer",
      payload: { transfer_id: "transfer-1" },
    }]));
    mockDb.update
      .mockReturnValueOnce(mockQueryBuilder(undefined))
      .mockReturnValueOnce(mockQueryBuilder([{ id: "rom-command" }]));

    const { POST } = await import("@/app/api/server/notify/route");
    const req = mkReq("http://localhost/api/server/notify", {
      ...jsonBody({
        command_id: "rom-command",
        sdp_answer: "v=0\r\nanswer",
        lease_token: "lease-rom",
      }),
      headers: authHeader(),
    });
    const resp = await POST(req as any);
    expect(resp.status).toBe(200);
    expect(await resp.json()).toMatchObject({ ok: true, transfer_id: "transfer-1" });
  });

  it("rejects notify for a command owned by another server", async () => {
    mockDb.select.mockReturnValueOnce(
      mockQueryBuilder([{ id: "cmd-1", serverId: "server-2", workerToken: "abc123" }]),
    );

    const { POST } = await import("@/app/api/server/notify/route");
    const req = mkReq("http://localhost/api/server/notify", {
      ...jsonBody({ command_id: "cmd-1", worker_url: "http://localhost:9999", game_id: "local_0123456789abcdef0123456789abcdef" }),
      headers: authHeader(),
    });
    const resp = await POST(req as any);
    expect(resp.status).toBe(404);
  });

  it("does not stop a session owned by another authenticated server", async () => {
    mockDb.select
      .mockReturnValueOnce(mockQueryBuilder([{
        id: "stop-command",
        serverId: "server-1",
        type: "stop_game",
        payload: {
          game_id: "local_0123456789abcdef0123456789abcdef",
          session_id: "session-on-server-2",
        },
      }]))
      .mockReturnValueOnce(mockQueryBuilder([{
        id: "session-on-server-2",
        status: "playing",
        serverId: "server-2",
        gameId: "local_0123456789abcdef0123456789abcdef",
      }]));
    mockDb.update.mockReturnValueOnce(mockQueryBuilder([{ id: "stop-command" }]));
    const { POST } = await import("@/app/api/server/notify/route");
    const req = mkReq("http://localhost/api/server/notify", {
      ...jsonBody({
        command_id: "stop-command",
        game_id: "local_0123456789abcdef0123456789abcdef",
        session_id: "session-on-server-2",
        action: "stop",
        lease_token: "lease-stop",
      }),
      headers: authHeader(),
    });

    const resp = await POST(req as any);

    expect(resp.status).toBe(409);
    expect(mockDb.update).not.toHaveBeenCalled();
  });

  it("does not apply a notify callback to an unrelated same-server session", async () => {
    mockDb.select
      .mockReturnValueOnce(mockQueryBuilder([{
        id: "cmd-game-a",
        serverId: "server-1",
        workerToken: "worker-a",
        type: "sdp_offer",
        payload: { game_id: "local_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
      }]))
      .mockReturnValueOnce(mockQueryBuilder([{
        id: "session-game-b",
        status: "playing",
        roomToken: "room-b",
        hostToken: "host-b",
        generation: 1,
        serverId: "server-1",
        gameId: "local_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        commandId: "cmd-game-b",
      }]))
      .mockReturnValueOnce(mockQueryBuilder([]));
    mockDb.update.mockReturnValueOnce(mockQueryBuilder([{ id: "cmd-game-a" }]));
    const { POST } = await import("@/app/api/server/notify/route");
    const req = mkReq("http://localhost/api/server/notify", {
      ...jsonBody({
        command_id: "cmd-game-a",
        worker_url: "http://localhost:9999",
        game_id: "local_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        session_id: "session-game-b",
        lease_token: "lease-a",
      }),
      headers: authHeader(),
    });

    const resp = await POST(req as any);

    expect(resp.status).toBe(409);
    expect(mockDb.select).toHaveBeenCalledTimes(1);
    expect(mockDb.update).not.toHaveBeenCalled();
  });

  it("requires an exact session id for worker-dead cleanup", async () => {
    const { POST } = await import("@/app/api/server/notify/route");
    const req = mkReq("http://localhost/api/server/notify", {
      ...jsonBody({
        command_id: "__worker_dead__",
        worker_url: "",
        game_id: "local_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        action: "stop",
      }),
      headers: authHeader(),
    });

    const resp = await POST(req as any);

    expect(resp.status).toBe(400);
    expect(mockDb.select).not.toHaveBeenCalled();
    expect(mockDb.update).not.toHaveBeenCalled();
  });

  it("does not revive an ended session from a leased callback", async () => {
    mockDb.select
      .mockReturnValueOnce(mockQueryBuilder([{
        id: "cmd-ended",
        serverId: "server-1",
        workerToken: "worker-ended",
        type: "sdp_offer",
        payload: {
          game_id: "local_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          host_token: "host-ended",
        },
      }]))
      .mockReturnValueOnce(mockQueryBuilder([{
        id: "session-ended",
        status: "ended",
        roomToken: "room-ended",
        hostToken: "host-ended",
        generation: 1,
        serverId: "server-1",
        gameId: "local_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        commandId: "cmd-start",
      }]));
    mockDb.update.mockReturnValueOnce(mockQueryBuilder([{ id: "cmd-ended" }]));
    const { POST } = await import("@/app/api/server/notify/route");
    const req = mkReq("http://localhost/api/server/notify", {
      ...jsonBody({
        command_id: "cmd-ended",
        worker_url: "http://localhost:9999",
        game_id: "local_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        session_id: "session-ended",
        lease_token: "lease-ended",
        sdp_answer: "answer",
      }),
      headers: authHeader(),
    });

    const resp = await POST(req as any);

    expect(resp.status).toBe(409);
    expect(mockDb.update).not.toHaveBeenCalled();
  });

  it("does not revive a session that ends between validation and update", async () => {
    mockDb.select
      .mockReturnValueOnce(mockQueryBuilder([{
        id: "cmd-race",
        serverId: "server-1",
        workerToken: "worker-race",
        type: "sdp_offer",
        payload: {
          game_id: "local_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          host_token: "host-race",
          session_id: "session-race",
        },
      }]))
      .mockReturnValueOnce(mockQueryBuilder([{
        id: "session-race",
        status: "ready",
        roomToken: "room-race",
        hostToken: "host-race",
        generation: 1,
        serverId: "server-1",
        gameId: "local_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        commandId: "cmd-start",
      }]));
    mockDb.update.mockReturnValueOnce(mockQueryBuilder([]));
    const { POST } = await import("@/app/api/server/notify/route");
    const req = mkReq("http://localhost/api/server/notify", {
      ...jsonBody({
        command_id: "cmd-race",
        worker_url: "http://localhost:9999",
        game_id: "local_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        session_id: "session-race",
        lease_token: "lease-race",
        sdp_answer: "answer",
      }),
      headers: authHeader(),
    });

    const resp = await POST(req as any);

    expect(resp.status).toBe(409);
    expect(await resp.json()).toEqual({ error: "session state changed" });
    expect(mockDb.transaction).toHaveBeenCalledTimes(1);
    expect(mockDb.update).toHaveBeenCalledTimes(1);
  });

  it("accepts an authorized stop action without worker_url", async () => {
    mockDb.select
      .mockReturnValueOnce(mockQueryBuilder([{
        id: "cmd-1",
        serverId: "server-1",
        type: "stop_game",
        payload: {
          game_id: "local_0123456789abcdef0123456789abcdef",
          session_id: "session-1",
        },
      }]))
      .mockReturnValueOnce(mockQueryBuilder([{
        id: "session-1",
        status: "playing",
        serverId: "server-1",
        gameId: "local_0123456789abcdef0123456789abcdef",
      }]));
    mockDb.update
      .mockReturnValueOnce(mockQueryBuilder([{ id: "cmd-1" }]))
      .mockReturnValueOnce(mockQueryBuilder([{ id: "session-1" }]));

    const { POST } = await import("@/app/api/server/notify/route");
    const req = mkReq("http://localhost/api/server/notify", {
      ...jsonBody({
        command_id: "cmd-1",
        worker_url: "",
        game_id: "local_0123456789abcdef0123456789abcdef",
        session_id: "session-1",
        action: "stop",
        lease_token: "lease-stop",
      }),
      headers: authHeader(),
    });
    const resp = await POST(req as any);
    expect(resp.status).toBe(200);
  });

  it("rejects a leased start callback without the exact prepared session", async () => {
    mockDb.select
      .mockReturnValueOnce(mockQueryBuilder([{
        id: "cmd-1",
        serverId: "server-1",
        workerToken: "abc123",
        type: "start_game",
        payload: { game_id: "local_0123456789abcdef0123456789abcdef" },
      }]))
      .mockReturnValueOnce(mockQueryBuilder([]))
      .mockReturnValueOnce(mockQueryBuilder([])); // no existing session
    mockDb.update.mockReturnValueOnce(mockQueryBuilder([{ id: "cmd-1" }]));

    const { POST } = await import("@/app/api/server/notify/route");
    const req = mkReq("http://localhost/api/server/notify", {
      ...jsonBody({
        command_id: "cmd-1",
        worker_url: "http://localhost:9999",
        game_id: "local_0123456789abcdef0123456789abcdef",
        lease_token: "lease-start",
      }),
      headers: authHeader(),
    });
    const resp = await POST(req as any);
    expect(resp.status).toBe(409);
    const body = await resp.json();
    expect(body.error).toBe("exact command session_id required");
  });
});

describe("POST /api/server/notify/poll", () => {
  it("rejects legacy GET query-string capabilities", async () => {
    const { GET } = await import("@/app/api/server/notify/route");
    const resp = await GET();
    expect(resp.status).toBe(405);
  });

  it("returns 400 without server_id", async () => {
    const { POST } = await import("@/app/api/server/notify/poll/route");
    const req = mkReq("http://localhost/api/server/notify/poll", {
      ...jsonBody({ worker_token: "abc123" }),
    });
    const resp = await POST(req);
    expect(resp.status).toBe(400);
  });

  it("returns 400 without worker_token", async () => {
    const { POST } = await import("@/app/api/server/notify/poll/route");
    const req = mkReq("http://localhost/api/server/notify/poll", {
      ...jsonBody({ server_id: "server-1" }),
    });
    const resp = await POST(req);
    expect(resp.status).toBe(400);
  });

  it("returns worker_url when the capability belongs to the requested server", async () => {
    mockDb.select.mockReturnValueOnce(
      mockQueryBuilder([{
        sessionId: "session-1",
        workerUrl: "http://localhost:9999",
        gameId: "local_0123456789abcdef0123456789abcdef",
        status: "ready",
        sdpAnswer: null,
        roomToken: "room-1",
        cmdResult: null,
      }]),
    );

    const { POST } = await import("@/app/api/server/notify/poll/route");
    const req = mkReq("http://localhost/api/server/notify/poll", {
      ...jsonBody({ server_id: "server-1", worker_token: "abc123" }),
    });
    const resp = await POST(req);
    expect(resp.status).toBe(200);
    expect(resp.headers.get("Cache-Control")).toBe("no-store");
    const body = await resp.json();
    expect(body.worker_url).toBe("http://localhost:9999");
    expect(body.game_id).toBe("local_0123456789abcdef0123456789abcdef");
  });

  it("does not use a worker capability issued to another server", async () => {
    mockDb.select
      .mockReturnValueOnce(mockQueryBuilder([]))
      .mockReturnValueOnce(mockQueryBuilder([{
        serverId: "server-2",
        gameId: { game_id: "local_0123456789abcdef0123456789abcdef" },
        sdpAnswerCmd: "secret-answer",
        cmdResult: null,
      }]));

    const { POST } = await import("@/app/api/server/notify/poll/route");
    const req = mkReq("http://localhost/api/server/notify/poll", {
      ...jsonBody({ server_id: "server-1", worker_token: "server-2-token" }),
    });
    const resp = await POST(req);
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.worker_url).toBeNull();
    expect(body.sdp_answer).toBeUndefined();
    expect(mockDb.select).toHaveBeenCalledTimes(2);
  });

  it("returns null worker_url when no session exists", async () => {
    mockDb.select.mockReturnValue(mockQueryBuilder([]));

    const { POST } = await import("@/app/api/server/notify/poll/route");
    const req = mkReq("http://localhost/api/server/notify/poll", {
      ...jsonBody({ server_id: "server-1", worker_token: "abc123" }),
    });
    const resp = await POST(req);
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.worker_url).toBeNull();
  });
});

// ── /api/room/shorten + resolve ─────────────────────────────────────────

describe("POST /api/room/shorten", () => {
  it("binds a browser-created host launch code to the enrolled member", async () => {
    mockVerifyBearerToken.mockResolvedValueOnce(null);
    mockDb.select.mockReturnValueOnce(mockQueryBuilder([{ role: "member" }]));
    const values = vi.fn(() => Promise.resolve(undefined));
    mockDb.insert.mockReturnValueOnce({ values });

    const { POST } = await import("@/app/api/room/shorten/route");
    const req = mkReq("http://localhost/api/room/shorten", {
      ...jsonBodyWithCsrf({
        game_id: "local_0123456789abcdef0123456789abcdef",
        host_token: "member-host-token",
        server_id: "server-1",
      }),
    });

    const resp = await POST(req);
    expect(resp.status).toBe(201);
    expect(values).toHaveBeenCalledWith(expect.objectContaining({
      createdBy: "user-1",
      hostToken: "member-host-token",
      serverId: "server-1",
    }));
  });
});

describe("GET /api/room/resolve/[code]", () => {
  it("returns the host capability only to the owning sc-server bearer", async () => {
    mockDb.select.mockReturnValueOnce(mockQueryBuilder([{
      gameId: "local_0123456789abcdef0123456789abcdef",
      hostToken: "host-secret",
      serverId: "server-1",
    }]));
    const { GET } = await import("@/app/api/room/resolve/[code]/route");
    const req = mkReq("http://localhost/api/room/resolve/ABC123", {
      headers: authHeader(),
    });

    const resp = await GET(req, { params: Promise.resolve({ code: "ABC123" }) });
    const body = await resp.json();

    expect(resp.status).toBe(200);
    expect(body.host_token).toBe("host-secret");
    expect(mockVerifyBearerToken).toHaveBeenCalledWith("Bearer scsk_test_api_key_12345");
  });

  it("resolves private invite codes as guests even for an owning server bearer", async () => {
    const roomToken = "a".repeat(32);
    mockDb.select
      .mockReturnValueOnce(mockQueryBuilder([{
        gameId: "local_0123456789abcdef0123456789abcdef",
        hostToken: roomToken,
        serverId: "server-1",
      }]))
      .mockReturnValueOnce(mockQueryBuilder([{
        roomToken,
        status: "playing",
      }]));
    const { GET } = await import("@/app/api/room/resolve/[code]/route");
    const req = mkReq("http://localhost/api/room/resolve/ABCDEFGHIJKLMNOP", {
      headers: authHeader(),
    });

    const resp = await GET(req, { params: Promise.resolve({ code: "ABCDEFGHIJKLMNOP" }) });
    const body = await resp.json();

    expect(resp.status).toBe(200);
    expect(body.room_token).toBe(roomToken);
    expect(body.host_token).toBeUndefined();
  });

  it("returns host launch authority to an explicit server admin", async () => {
    mockVerifyBearerToken.mockResolvedValueOnce(null);
    mockDb.select
      .mockReturnValueOnce(mockQueryBuilder([{
        gameId: "local_0123456789abcdef0123456789abcdef",
        hostToken: "host-secret",
        serverId: "server-1",
      }]))
      .mockReturnValueOnce(mockQueryBuilder([{ role: "admin" }]));
    const { GET } = await import("@/app/api/room/resolve/[code]/route");
    const req = mkReq("http://localhost/api/room/resolve/ABCDEFGHIJKLMNOP");

    const resp = await GET(req, { params: Promise.resolve({ code: "ABCDEFGHIJKLMNOP" }) });
    const body = await resp.json();

    expect(resp.status).toBe(200);
    expect(body.host_token).toBe("host-secret");
  });

  it("returns host launch authority to the enrolled member who created the code", async () => {
    mockVerifyBearerToken.mockResolvedValueOnce(null);
    mockDb.select
      .mockReturnValueOnce(mockQueryBuilder([{
        gameId: "local_0123456789abcdef0123456789abcdef",
        hostToken: "member-host-secret",
        serverId: "server-1",
        createdBy: "user-1",
      }]))
      .mockReturnValueOnce(mockQueryBuilder([{ role: "member" }]));
    const { GET } = await import("@/app/api/room/resolve/[code]/route");
    const req = mkReq("http://localhost/api/room/resolve/ABCDEFGHIJKLMNOP");

    const resp = await GET(req, { params: Promise.resolve({ code: "ABCDEFGHIJKLMNOP" }) });
    const body = await resp.json();

    expect(resp.status).toBe(200);
    expect(body.host_token).toBe("member-host-secret");
    expect(body.room_token).toBeUndefined();
  });

  it("does not grant one member host authority over another member's launch code", async () => {
    mockVerifyBearerToken.mockResolvedValueOnce(null);
    mockDb.select
      .mockReturnValueOnce(mockQueryBuilder([{
        gameId: "local_0123456789abcdef0123456789abcdef",
        hostToken: "host-secret",
        serverId: "server-1",
        createdBy: "user-2",
      }]))
      .mockReturnValueOnce(mockQueryBuilder([{ role: "member" }]))
      .mockReturnValueOnce(mockQueryBuilder([{
        roomToken: "room-private",
        status: "playing",
      }]));
    const { GET } = await import("@/app/api/room/resolve/[code]/route");
    const req = mkReq("http://localhost/api/room/resolve/ABCDEFGHIJKLMNOP");

    const resp = await GET(req, { params: Promise.resolve({ code: "ABCDEFGHIJKLMNOP" }) });
    const body = await resp.json();

    expect(resp.status).toBe(200);
    expect(body.room_token).toBe("room-private");
    expect(body.host_token).toBeUndefined();
  });

  it("forces the launch creator through the guest path when ?join is present", async () => {
    mockDb.select
      .mockReturnValueOnce(mockQueryBuilder([{
        gameId: "local_0123456789abcdef0123456789abcdef",
        hostToken: "member-host-secret",
        serverId: "server-1",
        createdBy: "user-1",
      }]))
      .mockReturnValueOnce(mockQueryBuilder([{
        roomToken: "room-private",
        status: "playing",
      }]));
    const { GET } = await import("@/app/api/room/resolve/[code]/route");
    const req = mkReq("http://localhost/api/room/resolve/ABCDEFGHIJKLMNOP?join");

    const resp = await GET(req, { params: Promise.resolve({ code: "ABCDEFGHIJKLMNOP" }) });
    const body = await resp.json();

    expect(resp.status).toBe(200);
    expect(body.room_token).toBe("room-private");
    expect(body.host_token).toBeUndefined();
  });

  it("does not accept a host capability supplied in the URL query", async () => {
    mockVerifyBearerToken.mockResolvedValueOnce(null);
    mockDb.select
      .mockReturnValueOnce(mockQueryBuilder([{
        gameId: "local_0123456789abcdef0123456789abcdef",
        hostToken: "host-secret",
        serverId: "server-1",
      }]))
      .mockReturnValueOnce(mockQueryBuilder([]))
      .mockReturnValueOnce(mockQueryBuilder([]));
    const { GET } = await import("@/app/api/room/resolve/[code]/route");
    const req = mkReq("http://localhost/api/room/resolve/ABC123?host_token=host-secret");

    const resp = await GET(req, { params: Promise.resolve({ code: "ABC123" }) });
    const body = await resp.json();

    expect(resp.status).toBe(404);
    expect(body.host_token).toBeUndefined();
  });
});

describe("POST /api/room/join", () => {
  it("rejects any guest join state outside the active allowlist", async () => {
    mockDb.select.mockReturnValueOnce(mockQueryBuilder([{
      id: "sess-unknown",
      workerUrl: "http://localhost:9999",
      gameId: "local_0123456789abcdef0123456789abcdef",
      serverId: "server-1",
      status: "unknown_future_state",
      maxSeats: 4,
      commandWorkerToken: "worker-token",
    }]));
    const { POST } = await import("@/app/api/room/join/route");
    const req = mkReq("http://localhost/api/room/join", {
      ...jsonBody({ room_token: "room-token", client_id: "client-1" }),
    });

    const resp = await POST(req);

    expect(resp.status).toBe(410);
    expect(mockDb.insert).not.toHaveBeenCalled();
  });

  it("never writes the room bearer capability to signaling logs", async () => {
    const log = vi.spyOn(console, "info").mockImplementation(() => undefined);
    mockDb.select.mockReturnValueOnce(mockQueryBuilder([]));
    const { POST } = await import("@/app/api/room/join/route");
    const req = mkReq("http://localhost/api/room/join", {
      ...jsonBody({ room_token: "secret-room-capability" }),
    });

    await POST(req);

    expect(log.mock.calls.flat().join(" ")).not.toContain("secret-room-capability");
  });

  it("resolves preview requests without minting a peer token", async () => {
    mockDb.select.mockReturnValueOnce(
      mockQueryBuilder([{
        id: "sess-1",
        workerUrl: "http://localhost:9999",
        gameId: "local_0123456789abcdef0123456789abcdef",
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

  it("mints a viewer-only preview token without consuming a player seat", async () => {
    // #762 wall preview: preview:true must mint a peer token with
    // role=viewer and a spectator seat (maxSeats+1) so the tile can open
    // a WebRTC leg without stealing a playable slot.
    mockDb.select.mockReturnValueOnce(
      mockQueryBuilder([{
        id: "sess-1",
        workerUrl: "http://localhost:9999",
        gameId: "local_0123456789abcdef0123456789abcdef",
        serverId: "server-1",
        status: "ready",
        maxSeats: 2,
        commandWorkerToken: "worker-123",
      }]),
    );
    mockDb.select.mockReturnValueOnce(mockQueryBuilder([])); // tx existing-peer lookup
    const insertBuilder = mockQueryBuilder(undefined);
    mockDb.insert.mockReturnValueOnce(insertBuilder);
    const valuesSpy = vi.spyOn(insertBuilder, "values");

    const { POST } = await import("@/app/api/room/join/route");
    const req = mkReq("http://localhost/api/room/join", {
      ...jsonBody({ room_token: "room-123", preview: true }),
    });
    const resp = await POST(req as any);
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.peer_token).toBeTruthy();
    expect(body.role).toBe("viewer");
    expect(body.seat).toBe(3); // maxSeats(2) + 1 — spectator, not a player slot
    expect(valuesSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        seat: 3,
        role: "viewer",
        clientId: "preview:room-123",
      }),
    );
  });

  it("reuses an existing peer token for the same client_id", async () => {
    mockDb.select
      .mockReturnValueOnce(
        mockQueryBuilder([{
          id: "sess-1",
          workerUrl: "http://localhost:9999",
          gameId: "local_0123456789abcdef0123456789abcdef",
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
    expect(body.capabilities.role).toBe("player");
    expect(mockDb.insert).not.toHaveBeenCalled();
  });

  it("returns spectator capabilities when reusing a viewer peer", async () => {
    mockDb.select
      .mockReturnValueOnce(mockQueryBuilder([{
        id: "sess-1",
        workerUrl: "http://localhost:9999",
        gameId: "local_0123456789abcdef0123456789abcdef",
        serverId: "server-1",
        status: "ready",
        maxSeats: 4,
        commandWorkerToken: "worker-123",
      }]))
      .mockReturnValueOnce(mockQueryBuilder([{ token: "peer-viewer", seat: 4, role: "viewer" }]));

    const { POST } = await import("@/app/api/room/join/route");
    const req = mkReq("http://localhost/api/room/join", {
      ...jsonBody({ room_token: "room-123", client_id: "viewer-client" }),
    });
    const resp = await POST(req as any);
    const body = await resp.json();

    expect(resp.status).toBe(200);
    expect(body.role).toBe("viewer");
    expect(body.capabilities.role).toBe("spectator");
    expect(mockDb.insert).not.toHaveBeenCalled();
  });

  it("returns spectator capabilities for a new join beyond maxSeats", async () => {
    mockDb.select
      .mockReturnValueOnce(mockQueryBuilder([{
        id: "sess-1",
        workerUrl: "http://localhost:9999",
        gameId: "local_0123456789abcdef0123456789abcdef",
        serverId: "server-1",
        status: "playing",
        maxSeats: 4,
        commandWorkerToken: "worker-123",
      }]))
      .mockReturnValueOnce(mockQueryBuilder([]))
      .mockReturnValueOnce(mockQueryBuilder([{ max: 4 }]));

    const { POST } = await import("@/app/api/room/join/route");
    const req = mkReq("http://localhost/api/room/join", {
      ...jsonBody({ room_token: "room-123", client_id: "viewer-client" }),
    });
    const resp = await POST(req as any);
    const body = await resp.json();

    expect(resp.status).toBe(200);
    expect(body.seat).toBe(5);
    expect(body.role).toBe("viewer");
    expect(body.capabilities.role).toBe("spectator");
  });
});


describe("POST /api/room/share", () => {
  it("creates an opaque private room capability without public publication semantics", async () => {
    mockDb.select.mockReturnValueOnce(mockQueryBuilder([{
      id: "sess-active",
      userId: "user-1",
      serverId: "server-1",
      status: "playing",
    }]));
    let updateSet: Record<string, unknown> | undefined;
    mockDb.update.mockReturnValueOnce({
      set: vi.fn((value: Record<string, unknown>) => {
        updateSet = value;
        return { where: vi.fn(() => Promise.resolve(undefined)) };
      }),
    });

    const { POST } = await import("@/app/api/room/share/route");
    const req = mkReq("http://localhost/api/room/share", {
      ...jsonBody({ session_id: "sess-active" }),
    });

    const resp = await POST(req);
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.room_token).toMatch(/^[a-f0-9]{32}$/);
    expect(body.room_token).not.toContain("public_");
    expect(updateSet).toMatchObject({ roomToken: body.room_token, maxSeats: 4 });
  });

  it("rejects timed-out sessions instead of rotating their room capability", async () => {
    mockDb.select.mockReturnValueOnce(mockQueryBuilder([{
      id: "sess-timed-out",
      userId: "user-1",
      serverId: "server-1",
      status: "timed_out",
    }]));
    const { POST } = await import("@/app/api/room/share/route");
    const req = mkReq("http://localhost/api/room/share", {
      ...jsonBody({ session_id: "sess-timed-out" }),
    });

    const resp = await POST(req);

    expect(resp.status).toBe(410);
    expect(mockDb.update).not.toHaveBeenCalled();
  });

  it("rejects an unrelated enrolled member rotating another member's room capability", async () => {
    mockDb.select
      .mockReturnValueOnce(mockQueryBuilder([{
        id: "sess-other-member",
        userId: "user-2",
        serverId: "server-1",
        status: "playing",
      }]))
      .mockReturnValueOnce(mockQueryBuilder([{ id: "membership-1", role: "member" }]));

    const { POST } = await import("@/app/api/room/share/route");
    const req = mkReq("http://localhost/api/room/share", {
      ...jsonBody({ session_id: "sess-other-member" }),
    });

    const resp = await POST(req);

    expect(resp.status).toBe(403);
    expect(mockDb.update).not.toHaveBeenCalled();
  });

  it("allows an administrator to rotate a member-owned room capability", async () => {
    mockDb.select
      .mockReturnValueOnce(mockQueryBuilder([{
        id: "sess-member",
        userId: "user-2",
        serverId: "server-1",
        status: "playing",
      }]))
      .mockReturnValueOnce(mockQueryBuilder([{ id: "membership-1", role: "admin" }]));

    const { POST } = await import("@/app/api/room/share/route");
    const req = mkReq("http://localhost/api/room/share", {
      ...jsonBody({ session_id: "sess-member" }),
    });

    const resp = await POST(req);

    expect(resp.status).toBe(200);
    expect(mockDb.update).toHaveBeenCalled();
  });

  it("allows the exact owning sc-server bearer to rotate a LAN room capability", async () => {
    mockAuth.mockResolvedValueOnce(null);
    mockDb.select.mockReturnValueOnce(mockQueryBuilder([{
      id: "sess-lan",
      userId: "user-1",
      serverId: "server-1",
      status: "playing",
    }]));
    let updateSet: Record<string, unknown> | undefined;
    mockDb.update.mockReturnValueOnce({
      set: vi.fn((value: Record<string, unknown>) => {
        updateSet = value;
        return { where: vi.fn(() => Promise.resolve(undefined)) };
      }),
    });

    const { POST } = await import("@/app/api/room/share/route");
    const req = mkReq("http://localhost/api/room/share", {
      ...jsonBody({ session_id: "sess-lan" }),
      headers: { ...jsonBody({}).headers, ...authHeader() },
    });

    const resp = await POST(req);
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.room_token).toMatch(/^[a-f0-9]{32}$/);
    expect(updateSet).toMatchObject({ roomToken: body.room_token });
  });

  it("rejects a sc-server bearer for another server's session", async () => {
    mockAuth.mockResolvedValueOnce(null);
    mockVerifyBearerToken.mockResolvedValueOnce({ id: "server-2", userId: "user-2" });
    mockDb.select.mockReturnValueOnce(mockQueryBuilder([{
      id: "sess-lan",
      userId: "user-1",
      serverId: "server-1",
      status: "playing",
    }]));

    const { POST } = await import("@/app/api/room/share/route");
    const req = mkReq("http://localhost/api/room/share", {
      ...jsonBody({ session_id: "sess-lan" }),
      headers: { ...jsonBody({}).headers, ...authHeader() },
    });

    const resp = await POST(req);
    expect(resp.status).toBe(403);
    expect(mockDb.update).not.toHaveBeenCalled();
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
    mockRunTurnProbe.mockResolvedValueOnce({
      state: "relayed",
      probed_at: new Date().toISOString(),
      latency_ms: 12,
      relay_family: "ipv4",
    });
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
    expect(body.phase4c_library_owner).toBe("sc-server");
    expect(body.components.db.status).toBe("ok");
    expect(body.components.sc_server.status).toBe("ok");
    expect(body.components.turn.status).toBe("ok");
    expect(body.components.turn.detail).toContain("verified");
    expect(body.connectivity.mode).toBe("turn-capable");
    expect(body.connectivity.transport_policy).toBe("all");
    expect(body.connectivity.turn_ready).toBe(true);
    expect(body.connectivity.turn_state).toBe("relayed");
    expect(body.connectivity.probe?.relay_family).toBe("ipv4");
    expect(body.connectivity.diagnostics.some((line: string) => line.includes("relay allocation verified"))).toBe(true);
    expect(body.versions.web).toMatchObject({ package_version: "0.1.0", git_sha: "web-sha-123" });
    expect(body.versions.server).toMatchObject({ git_sha: "server-sha" });
    expect(body.versions.worker).toMatchObject({ git_sha: "worker-sha" });
    expect(body.versions.runner).toMatchObject({ git_sha: "runner-sha" });
    expect(body.versions.source_server).toMatchObject({ id: "server-1", name: "Home PC" });
  });

  it("fails closed when TURN is configured but the relay probe fails", async () => {
    mockRunTurnProbe.mockResolvedValueOnce({
      state: "failed",
      probed_at: new Date().toISOString(),
      error: "no response from turn.example.com:3478 within 3000ms",
    });
    mockDb.execute.mockResolvedValueOnce(undefined);
    mockDb.select.mockReturnValueOnce(mockQueryBuilder([{}]));
    mockDb.select.mockReturnValueOnce(
      mockQueryBuilder([{ id: "server-1", lastSeenAt: new Date() }]),
    );
    mockDb.select.mockReturnValueOnce(
      mockQueryBuilder([{ roomToken: "x", maxSeats: 1, sdpAnswer: null }]),
    );
    mockDb.select.mockReturnValueOnce(
      mockQueryBuilder([{ id: "server-1", lastSeenAt: new Date() }]),
    );

    const { GET } = await import("@/app/api/health/route");
    const prevTurnUrls = process.env.GV_ICE_TURN_URLS;
    const prevTurnUser = process.env.GV_ICE_TURN_USERNAME;
    const prevTurnCred = process.env.GV_ICE_TURN_CREDENTIAL;
    process.env.GV_ICE_TURN_URLS = "turn:turn.example.com:3478";
    process.env.GV_ICE_TURN_USERNAME = "gv";
    process.env.GV_ICE_TURN_CREDENTIAL = "secret";
    const resp = await GET();
    process.env.GV_ICE_TURN_URLS = prevTurnUrls;
    process.env.GV_ICE_TURN_USERNAME = prevTurnUser;
    process.env.GV_ICE_TURN_CREDENTIAL = prevTurnCred;
    expect(resp.status).toBe(503);
    const body = await resp.json();
    expect(body.status).toBe("error");
    expect(body.components.turn.status).toBe("error");
    expect(body.connectivity.mode).toBe("turn-failed");
    expect(body.connectivity.turn_ready).toBe(false);
    expect(body.connectivity.turn_state).toBe("failed");
  });

  it("reports LAN mode without probing when TURN is unconfigured", async () => {
    mockDb.execute.mockResolvedValueOnce(undefined);
    mockDb.select.mockReturnValueOnce(mockQueryBuilder([{}]));
    mockDb.select.mockReturnValueOnce(
      mockQueryBuilder([{ id: "server-1", lastSeenAt: new Date() }]),
    );
    mockDb.select.mockReturnValueOnce(
      mockQueryBuilder([{ roomToken: "x", maxSeats: 1, sdpAnswer: null }]),
    );
    mockDb.select.mockReturnValueOnce(
      mockQueryBuilder([{ id: "server-1", lastSeenAt: new Date() }]),
    );

    const { GET } = await import("@/app/api/health/route");
    const prevStun = process.env.GV_ICE_STUN_URLS;
    const prevTurnUrls = process.env.GV_ICE_TURN_URLS;
    const prevTurnUser = process.env.GV_ICE_TURN_USERNAME;
    const prevTurnCred = process.env.GV_ICE_TURN_CREDENTIAL;
    delete process.env.GV_ICE_STUN_URLS;
    delete process.env.GV_ICE_TURN_URLS;
    delete process.env.GV_ICE_TURN_USERNAME;
    delete process.env.GV_ICE_TURN_CREDENTIAL;
    const resp = await GET();
    process.env.GV_ICE_STUN_URLS = prevStun;
    process.env.GV_ICE_TURN_URLS = prevTurnUrls;
    process.env.GV_ICE_TURN_USERNAME = prevTurnUser;
    process.env.GV_ICE_TURN_CREDENTIAL = prevTurnCred;
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.connectivity.mode).toBe("lan-only");
    expect(body.connectivity.turn_ready).toBe(false);
    expect(body.components.turn.status).toBe("ok");
    expect(mockRunTurnProbe).not.toHaveBeenCalled();
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

  it("reports stamped runtime-version.json provenance when present (#661)", async () => {
    mockDb.execute.mockResolvedValueOnce(undefined);
    mockDb.select.mockReturnValue(mockQueryBuilder([{}]));
    mockDb.select.mockReturnValue(mockQueryBuilder([]));

    const dir = mkdtempSync(join(tmpdir(), "sc-web-runtime-version-"));
    const stamped = join(dir, "runtime-version.json");
    writeFileSync(
      stamped,
      JSON.stringify({
        git_sha: "9fee9c0abcdef0123456789abcdef0123456789",
        package_version: "0.3.0",
        built_at_utc: "2026-08-03T00:00:00Z",
      }),
    );

    const prevPath = process.env.GV_RUNTIME_VERSION_PATH;
    const prevVersion = process.env.GV_WEB_VERSION;
    const prevSha = process.env.GV_WEB_GIT_SHA;
    process.env.GV_RUNTIME_VERSION_PATH = stamped;
    process.env.GV_WEB_VERSION = "0.1.0";
    process.env.GV_WEB_GIT_SHA = "web-sha-123";
    const { GET } = await import("@/app/api/health/route");
    const resp = await GET();
    process.env.GV_RUNTIME_VERSION_PATH = prevPath;
    process.env.GV_WEB_VERSION = prevVersion;
    process.env.GV_WEB_GIT_SHA = prevSha;

    expect(resp.status).toBe(200);
    const body = await resp.json();
    // Stamped file wins over env vars: exact full SHA and non-unknown fields.
    expect(body.versions.web.package_version).toBe("0.3.0");
    expect(body.versions.web.git_sha).toBe("9fee9c0abcdef0123456789abcdef0123456789");
    expect(body.versions.web.released_at_utc).toBe("2026-08-03T00:00:00Z");
  });

  it("fails closed (unknown provenance) when runtime-version.json is absent and env is unset (#661)", async () => {
    mockDb.execute.mockResolvedValueOnce(undefined);
    mockDb.select.mockReturnValue(mockQueryBuilder([{}]));
    mockDb.select.mockReturnValue(mockQueryBuilder([]));

    const prevPath = process.env.GV_RUNTIME_VERSION_PATH;
    const prevVersion = process.env.GV_WEB_VERSION;
    const prevSha = process.env.GV_WEB_GIT_SHA;
    const prevReleased = process.env.GV_WEB_RELEASED_AT_UTC;
    delete process.env.GV_RUNTIME_VERSION_PATH;
    delete process.env.GV_WEB_VERSION;
    delete process.env.GV_WEB_GIT_SHA;
    delete process.env.GV_WEB_RELEASED_AT_UTC;
    const { GET } = await import("@/app/api/health/route");
    const resp = await GET();
    process.env.GV_RUNTIME_VERSION_PATH = prevPath;
    process.env.GV_WEB_VERSION = prevVersion;
    process.env.GV_WEB_GIT_SHA = prevSha;
    process.env.GV_WEB_RELEASED_AT_UTC = prevReleased;

    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.versions.web.package_version).toBe("unknown");
    expect(body.versions.web.git_sha).toBeUndefined();
    expect(body.versions.web.released_at_utc).toBeUndefined();
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
    const req = mkReq("http://localhost/api/playable-hosts?game_id=local_0123456789abcdef0123456789abcdef&server_id=server-1");
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
    const req = mkReq("http://localhost/api/playable-hosts?game_id=local_0123456789abcdef0123456789abcdef&server_id=server-1");
    const resp = await GET(req);
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.hosts).toEqual([]);
  });

  it("treats an explicitly namespaced server-owned game as available", async () => {
    mockDb.select.mockReturnValue(
      mockQueryBuilder([
        {
          serverId: "server-local",
          serverName: "Local Vault",
          lastSeenAt: new Date(),
          metadata: {},
          gameFileId: null,
        },
      ]),
    );

    const { GET } = await import("@/app/api/playable-hosts/route");
    const req = mkReq("http://localhost/api/playable-hosts?game_id=local_0123456789abcdef0123456789abcdef&server_id=server-local");
    const resp = await GET(req);
    const body = await resp.json();

    expect(resp.status).toBe(200);
    expect(body.hosts).toHaveLength(1);
    expect(body.hosts[0]).toMatchObject({ server_id: "server-local", has_game: true });
  });

  it("returns the owning host with server metadata", async () => {
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

      ]),
    );

    const { GET } = await import("@/app/api/playable-hosts/route");
    const req = mkReq("http://localhost/api/playable-hosts?game_id=local_0123456789abcdef0123456789abcdef&server_id=server-1");
    const resp = await GET(req);
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.hosts).toHaveLength(1);
    expect(body.hosts[0]).toMatchObject({
      server_id: "server-1",
      name: "Home PC",
      has_game: true,
      capabilities: { lan: true, stun: true, turn: false },
      lan: {
        player_port: 8787,
        player_urls: ["http://192.168.1.100:8787/"],
        health_urls: ["http://192.168.1.100:8787/health"],
      },
    });

  });

  it("only returns servers the user is a member of", async () => {
    // Query filters by serverMembers.userId — mock empty result
    mockDb.select.mockReturnValue(mockQueryBuilder([]));
    const { GET } = await import("@/app/api/playable-hosts/route");
    const req = mkReq("http://localhost/api/playable-hosts?game_id=local_0123456789abcdef0123456789abcdef&server_id=server-1");
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
    const req = mkReq("http://localhost/api/playable-hosts?game_id=local_0123456789abcdef0123456789abcdef&server_id=server-1");
    const resp = await GET(req);
    const body = await resp.json();
    expect(body.hosts[0].status).toBe("online");
    expect(body.hosts[1].status).toBe("stale");
    expect(body.hosts[2].status).toBe("offline");
  });

  it("classifies server capabilities from metadata", async () => {
    mockDb.select.mockReturnValue(
      mockQueryBuilder([
        {
          serverId: "s1", serverName: "LAN", lastSeenAt: new Date(),
          metadata: { interfaces: [{ name: "eth0", address: "192.168.1.100" }], ice: { turn_configured: false } },
          gameFileId: "gf1",
        },
        {
          serverId: "s2", serverName: "STUN only", lastSeenAt: new Date(),
          metadata: { interfaces: [], ice: { turn_configured: false } },
          gameFileId: "gf2",
        },
        {
          serverId: "s3", serverName: "TURN", lastSeenAt: new Date(),
          metadata: { interfaces: [], ice: { turn_configured: true } },
          gameFileId: "gf3",
        },
      ]),
    );

    const { GET } = await import("@/app/api/playable-hosts/route");
    const req = mkReq("http://localhost/api/playable-hosts?game_id=local_0123456789abcdef0123456789abcdef&server_id=server-1");
    const resp = await GET(req);
    const body = await resp.json();
    expect(body.hosts[0].capabilities).toEqual({ lan: true, stun: true, turn: false });
    expect(body.hosts[1].capabilities).toEqual({ lan: false, stun: true, turn: false });
    expect(body.hosts[2].capabilities).toEqual({ lan: false, stun: true, turn: true });
  });

  it("classifies explicit LAN health metadata as having LAN capability", async () => {
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
    const req = mkReq("http://localhost/api/playable-hosts?game_id=local_0123456789abcdef0123456789abcdef&server_id=server-1");
    const resp = await GET(req);
    const body = await resp.json();
    expect(body.hosts[0].capabilities).toEqual({ lan: true, stun: true, turn: true });
    expect(body.hosts[0].lan.health_urls).toEqual(["http://192.0.2.50:8787/health"]);
  });

  it("returns all-false capabilities when metadata is missing", async () => {
    mockDb.select.mockReturnValue(
      mockQueryBuilder([
        { serverId: "s1", serverName: "Unknown", lastSeenAt: new Date(), metadata: {}, gameFileId: "gf1" },
      ]),
    );
    const { GET } = await import("@/app/api/playable-hosts/route");
    const req = mkReq("http://localhost/api/playable-hosts?game_id=local_0123456789abcdef0123456789abcdef&server_id=server-1");
    const resp = await GET(req);
    const body = await resp.json();
    expect(body.hosts[0].capabilities).toEqual({ lan: false, stun: false, turn: false });
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
    expect(body.features.xmb).toBeUndefined();
  });

  it("returns auth + server memberships without cloud library metadata", async () => {
    mockDb.select.mockReturnValueOnce(
      mockQueryBuilder([{
        id: "server-1",
        name: "Bazzite",
        lastSeenAt: new Date("2026-07-13T12:00:00.000Z"),
        role: "admin",
      }]),
    );

    const { GET } = await import("@/app/api/client/bootstrap/route");
    const resp = await GET();
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.auth.authenticated).toBe(true);
    expect(body.auth.userId).toBe("user-1");
    expect(body.servers).toHaveLength(1);
    expect(body.servers[0].name).toBe("Bazzite");
    expect(body.servers[0].gameCount).toBeUndefined();
    expect(body.servers[0].role).toBe("admin");
    expect(body.servers[0].lastSeenAt).toBe("2026-07-13T12:00:00.000Z");
    expect(body.library).toBeNull();
    expect(typeof body.ice.stunConfigured).toBe("boolean");
  });
});

describe("PUT /api/servers/[server_id]/core-overrides", () => {
  it("rejects an enrolled non-admin member", async () => {
    mockDb.select.mockReturnValueOnce(mockQueryBuilder([{ role: "member" }]));
    const { PUT } = await import("@/app/api/servers/[server_id]/core-overrides/route");
    const req = mkReq("http://localhost/api/servers/server-1/core-overrides", {
      ...jsonBodyWithCsrf({ overrides: { SNES: "snes9x_libretro.so" } }),
    });

    const resp = await PUT(req, { params: Promise.resolve({ server_id: "server-1" }) });

    expect(resp.status).toBe(403);
    expect(mockDb.update).not.toHaveBeenCalled();
  });

  it("requires csrf protection for an administrator mutation", async () => {
    mockDb.select.mockReturnValueOnce(mockQueryBuilder([{ role: "admin" }]));
    const { PUT } = await import("@/app/api/servers/[server_id]/core-overrides/route");
    const req = mkReq("http://localhost/api/servers/server-1/core-overrides", {
      ...jsonBody({ overrides: { SNES: "snes9x_libretro.so" } }),
    });

    const resp = await PUT(req, { params: Promise.resolve({ server_id: "server-1" }) });

    expect(resp.status).toBe(403);
    expect(mockDb.update).not.toHaveBeenCalled();
  });

  it("accepts an administrator mutation with a valid csrf token", async () => {
    mockDb.select
      .mockReturnValueOnce(mockQueryBuilder([{ role: "admin" }]))
      .mockReturnValueOnce(mockQueryBuilder([{ metadata: {} }]));
    const { PUT } = await import("@/app/api/servers/[server_id]/core-overrides/route");
    const req = mkReq("http://localhost/api/servers/server-1/core-overrides", {
      ...jsonBodyWithCsrf({ overrides: { SNES: "snes9x_libretro.so" } }),
    });

    const resp = await PUT(req, { params: Promise.resolve({ server_id: "server-1" }) });

    expect(resp.status).toBe(200);
    expect(mockDb.update).toHaveBeenCalled();
  });
});

describe("POST /api/server/sync-games", () => {
  beforeEach(() => {
    mockVerifyBearerToken.mockReset();
    mockVerifyBearerToken.mockResolvedValue({
      id: "server-1",
      userId: "user-1",
      name: "sc-server",
      apiKeyHash: "hashed_key",
    });
    mockDb.delete.mockReset();
    mockDb.insert.mockReset();
    mockDb.insert.mockReturnValue(mockQueryBuilder(undefined));
  });

  function syncReq(body: unknown) {
    return new NextRequest("http://localhost/api/server/sync-games", {
      method: "POST",
      headers: {
        authorization: "Bearer scsk_test_api_key_12345",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
  }

  it("stores DAT verification evidence with the game", async () => {
    const { POST } = await import("@/app/api/server/sync-games/route");
    const resp = await POST(syncReq({
      games: [{
        id: "local_abc",
        name: "Super Mario World (USA)",
        source_name: "smw.sfc",
        platform: "SNES",
        max_players: 2,
        verification: {
          state: "verified",
          canonical_title: "Super Mario World (USA)",
          canonical_platform: "SNES",
          region: "USA",
          revision: "Rev 1",
          confidence: "sha1",
          catalog_name: "Nintendo - Super Nintendo Entertainment System",
          catalog_version: "20240115",
          catalog_sha256: "cafe0123",
          source_name: "smw.sfc",
          enriched_at: "2026-08-05T00:00:00Z",
        },
      }],
    }));

    expect(resp.status).toBe(200);
    const insertBuilder = mockDb.insert.mock.results[0].value;
    expect(insertBuilder.values).toHaveBeenCalledWith(expect.objectContaining({
      verificationState: "verified",
      canonicalTitle: "Super Mario World (USA)",
      region: "USA",
      revision: "Rev 1",
      confidence: "sha1",
      catalogName: "Nintendo - Super Nintendo Entertainment System",
      catalogVersion: "20240115",
      catalogSha256: "cafe0123",
      verificationSourceName: "smw.sfc",
      enrichedAt: "2026-08-05T00:00:00Z",
    }));
  });

  it("rejects invalid verification payloads fail-closed to no evidence", async () => {
    const { POST } = await import("@/app/api/server/sync-games/route");
    const resp = await POST(syncReq({
      games: [{
        id: "local_abc",
        name: "Some Game",
        platform: "NES",
        max_players: 2,
        verification: {
          state: "admin-approved",
          canonical_title: "x".repeat(999),
        },
      }],
    }));

    expect(resp.status).toBe(200);
    const insertBuilder = mockDb.insert.mock.results[0].value;
    expect(insertBuilder.values).toHaveBeenCalledWith(expect.objectContaining({
      verificationState: null,
      canonicalTitle: null,
      catalogSha256: null,
    }));
  });

  it("bounds over-long fields even when the state is valid", async () => {
    const { POST } = await import("@/app/api/server/sync-games/route");
    const resp = await POST(syncReq({
      games: [{
        id: "local_abc",
        name: "Some Game",
        platform: "NES",
        max_players: 2,
        verification: {
          state: "unverified",
          canonical_title: "x".repeat(999),
          catalog_name: "ok",
        },
      }],
    }));

    expect(resp.status).toBe(200);
    const insertBuilder = mockDb.insert.mock.results[0].value;
    expect(insertBuilder.values).toHaveBeenCalledWith(expect.objectContaining({
      verificationState: "unverified",
      canonicalTitle: null,
      catalogName: "ok",
    }));
  });
});

// ── PATCH /api/games/flags (Living Cabinet wall, #762) ────────────────

function jsonPatchWithCsrf(body: unknown, csrf = "csrf-test-token") {
  return {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      "x-csrf-token": csrf,
      cookie: `sc_csrf_token=${csrf}`,
    },
    body: JSON.stringify(body),
  };
}

describe("PATCH /api/games/flags", () => {
  it("rejects unauthenticated requests", async () => {
    mockAuth.mockResolvedValueOnce(null);
    const { PATCH } = await import("@/app/api/games/flags/route");
    const resp = await PATCH(
      mkReq("http://localhost/api/games/flags", jsonPatchWithCsrf({ serverId: "server-1", gameId: "game-1", public: true })),
    );
    expect(resp.status).toBe(401);
  });

  it("rejects requests without a valid CSRF token", async () => {
    const { PATCH } = await import("@/app/api/games/flags/route");
    const resp = await PATCH(
      mkReq("http://localhost/api/games/flags", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ serverId: "server-1", gameId: "game-1", public: true }),
      }),
    );
    expect(resp.status).toBe(403);
    expect((await resp.json()).error).toContain("csrf");
  });

  it("rejects members who are not admins", async () => {
    mockDb.select.mockReturnValueOnce(mockQueryBuilder([{ role: "member" }]));
    const { PATCH } = await import("@/app/api/games/flags/route");
    const resp = await PATCH(
      mkReq("http://localhost/api/games/flags", jsonPatchWithCsrf({ serverId: "server-1", gameId: "game-1", public: true })),
    );
    expect(resp.status).toBe(403);
    expect((await resp.json()).error).toContain("administrator");
  });

  it("returns 404 when the server is not a member server", async () => {
    mockDb.select.mockReturnValueOnce(mockQueryBuilder([]));
    const { PATCH } = await import("@/app/api/games/flags/route");
    const resp = await PATCH(
      mkReq("http://localhost/api/games/flags", jsonPatchWithCsrf({ serverId: "server-1", gameId: "game-1", public: true })),
    );
    expect(resp.status).toBe(404);
  });

  it("returns 404 when the game is not in the catalog", async () => {
    mockDb.select
      .mockReturnValueOnce(mockQueryBuilder([{ role: "admin" }]))
      .mockReturnValueOnce(mockQueryBuilder([]));
    const { PATCH } = await import("@/app/api/games/flags/route");
    const resp = await PATCH(
      mkReq("http://localhost/api/games/flags", jsonPatchWithCsrf({ serverId: "server-1", gameId: "game-1", public: true })),
    );
    expect(resp.status).toBe(404);
  });

  it("rejects malformed bodies", async () => {
    const { PATCH } = await import("@/app/api/games/flags/route");
    for (const body of [
      { serverId: "server-1" }, // missing gameId
      { gameId: "game-1" }, // missing serverId
      { serverId: "server-1", gameId: "game-1" }, // nothing to update
      { serverId: "server-1", gameId: "game-1", public: "yes" }, // non-boolean
    ]) {
      const resp = await PATCH(mkReq("http://localhost/api/games/flags", jsonPatchWithCsrf(body)));
      expect(resp.status).toBe(400);
    }
  });

  it("upserts flags for an admin and returns the saved flags", async () => {
    mockDb.select
      .mockReturnValueOnce(mockQueryBuilder([{ role: "admin" }])) // membership
      .mockReturnValueOnce(mockQueryBuilder([{ gameId: "game-1" }])) // catalog row
      .mockReturnValueOnce(mockQueryBuilder([])); // no existing flags
    mockDb.insert.mockReturnValueOnce(
      mockQueryBuilder([{ alwaysOn: true, public: true, updatedAt: new Date("2026-08-05T00:00:00Z") }]),
    );
    const { PATCH } = await import("@/app/api/games/flags/route");
    const resp = await PATCH(
      mkReq("http://localhost/api/games/flags", jsonPatchWithCsrf({ serverId: "server-1", gameId: "game-1", alwaysOn: true, public: true })),
    );
    expect(resp.status).toBe(200);
    const data = await resp.json();
    expect(data.flags.alwaysOn).toBe(true);
    expect(data.flags.public).toBe(true);
    // The insert carried the gateway-owned payload (host syncs can't wipe it).
    const insertPayload = mockDb.insert.mock.results[0].value.values.mock.calls[0][0];
    expect(insertPayload).toMatchObject({ serverId: "server-1", gameId: "game-1", alwaysOn: true, public: true });
  });

  it("preserves unspecified flags from an existing row", async () => {
    mockDb.select
      .mockReturnValueOnce(mockQueryBuilder([{ role: "admin" }])) // membership
      .mockReturnValueOnce(mockQueryBuilder([{ gameId: "game-1" }])) // catalog row
      .mockReturnValueOnce(mockQueryBuilder([{ alwaysOn: true, public: false }])); // existing flags
    mockDb.insert.mockReturnValueOnce(
      mockQueryBuilder([{ alwaysOn: true, public: true, updatedAt: new Date("2026-08-05T00:00:00Z") }]),
    );
    const { PATCH } = await import("@/app/api/games/flags/route");
    const resp = await PATCH(
      mkReq("http://localhost/api/games/flags", jsonPatchWithCsrf({ serverId: "server-1", gameId: "game-1", public: true })),
    );
    expect(resp.status).toBe(200);
    const insertPayload = mockDb.insert.mock.results[0].value.values.mock.calls[0][0];
    expect(insertPayload).toMatchObject({ alwaysOn: true, public: true });
  });
});

// ── GET /api/games carries gateway-owned flags ────────────────────────

describe("GET /api/games includes flags", () => {
  const baseRow = {
    verificationState: null,
    canonicalTitle: null,
    canonicalPlatform: null,
    region: null,
    revision: null,
    confidence: null,
    catalogName: null,
    catalogVersion: null,
    catalogSha256: null,
    verificationSourceName: null,
    enrichedAt: null,
  };

  it("returns alwaysOn/public per game row", async () => {
    mockDb.select
      .mockReturnValueOnce(mockQueryBuilder([{ serverId: "server-1" }])) // memberships
      .mockReturnValueOnce(mockQueryBuilder([])) // platform facets
      .mockReturnValueOnce(mockQueryBuilder([{ count: 1 }])) // total
      .mockReturnValueOnce(
        mockQueryBuilder([
          {
            id: "game-1",
            name: "Gauntlet",
            platform: "Arcade",
            serverId: "server-1",
            maxPlayers: 4,
            alwaysOn: true,
            public: true,
            ...baseRow,
          },
        ]),
      ); // rows
    const { GET } = await import("@/app/api/games/route");
    const resp = await GET(mkReq("http://localhost/api/games"));
    expect(resp.status).toBe(200);
    const data = await resp.json();
    expect(data.games[0].alwaysOn).toBe(true);
    expect(data.games[0].public).toBe(true);
  });

  it("defaults missing flags to false", async () => {
    mockDb.select
      .mockReturnValueOnce(mockQueryBuilder([{ serverId: "server-1" }])) // memberships
      .mockReturnValueOnce(mockQueryBuilder([])) // platform facets
      .mockReturnValueOnce(mockQueryBuilder([{ count: 1 }])) // total
      .mockReturnValueOnce(
        mockQueryBuilder([
          {
            id: "game-2",
            name: "Tetris",
            platform: "Game Boy",
            serverId: "server-1",
            maxPlayers: 1,
            alwaysOn: null,
            public: null,
            ...baseRow,
          },
        ]),
      ); // rows
    const { GET } = await import("@/app/api/games/route");
    const resp = await GET(mkReq("http://localhost/api/games"));
    const data = await resp.json();
    expect(data.games[0].alwaysOn).toBe(false);
    expect(data.games[0].public).toBe(false);
  });
});

// ── GET /api/wall (Living Cabinet wall, #762) ─────────────────────────

describe("GET /api/wall", () => {
  it("is public (no auth) and returns only public games with live state", async () => {
    mockDb.select
      .mockReturnValueOnce(
        mockQueryBuilder([
          {
            gameId: "gauntlet",
            name: "Gauntlet",
            platform: "Arcade",
            maxPlayers: 4,
            serverId: "server-1",
            serverName: "arcade-1",
            serverOnline: true,
            sessionId: "sess-1",
            sessionStatus: "playing",
            roomToken: "room-tok-1",
            sessionMaxSeats: 2,
            stateEnteredAt: new Date(),
          },
          {
            gameId: "tetris",
            name: "Tetris",
            platform: "Game Boy",
            maxPlayers: 1,
            serverId: "server-1",
            serverName: "arcade-1",
            serverOnline: true,
            sessionId: null,
            sessionStatus: null,
            roomToken: null,
            sessionMaxSeats: null,
            stateEnteredAt: null,
          },
        ]),
      ) // wall rows
      .mockReturnValueOnce(
        mockQueryBuilder([
          { sessionId: "sess-1", role: "player", count: 1 },
          { sessionId: "sess-1", role: "viewer", count: 2 },
        ]),
      ); // peer counts
    const { GET } = await import("@/app/api/wall/route");
    const resp = await GET();
    expect(resp.status).toBe(200);
    const data = await resp.json();
    expect(data.games).toHaveLength(2);

    const live = data.games.find((g: { id: string }) => g.id === "gauntlet");
    expect(live.live).toBe(true);
    expect(live.players).toBe(1);
    expect(live.viewers).toBe(2);
    expect(live.roomUrl).toContain("/r/room-tok-1");
    expect(live.roomUrl).toContain("game_id=gauntlet");
    expect(live.roomUrl).toContain("server_id=server-1");
    expect(live.coverUrl).toBe("/api/covers/server-1/gauntlet");
    // #781: stable shareable watch link (slug from name, not room token)
    expect(live.slug).toBe("gauntlet");
    expect(live.watchUrl).toBe("/watch/gauntlet");

    const idle = data.games.find((g: { id: string }) => g.id === "tetris");
    expect(idle.live).toBe(false);
    expect(idle.roomUrl).toBeUndefined();
    expect(idle.players).toBe(0);
  });

  it("exposes no server metadata or tokens beyond the wall fields", async () => {
    mockDb.select
      .mockReturnValueOnce(
        mockQueryBuilder([
          {
            gameId: "gauntlet",
            name: "Gauntlet",
            platform: "Arcade",
            maxPlayers: 4,
            serverId: "server-1",
            serverName: "arcade-1",
            serverOnline: false,
            sessionId: null,
            sessionStatus: null,
            roomToken: null,
            sessionMaxSeats: null,
            stateEnteredAt: null,
          },
        ]),
      ) // wall rows
      .mockReturnValueOnce(mockQueryBuilder([])); // peer counts (no live sessions)
    const { GET } = await import("@/app/api/wall/route");
    const data = await (await GET()).json();
    const raw = JSON.stringify(data);
    expect(raw).not.toContain("host_token");
    expect(raw).not.toContain("api_key");
    expect(raw).not.toContain("metadata");
  });
});

// ── GET /api/covers public carve-out (#762) ───────────────────────────

const PNG_1PX =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

describe("GET /api/covers/[server_id]/[game_id] public carve-out", () => {
  it("fails closed: unauthenticated + non-public game → 404", async () => {
    mockAuth.mockResolvedValueOnce(null);
    mockDb.select.mockReturnValueOnce(mockQueryBuilder([])); // public flag lookup
    const { GET } = await import("@/app/api/covers/[server_id]/[game_id]/route");
    const resp = await GET(
      mkReq("http://localhost/api/covers/server-1/game-1"),
      { params: Promise.resolve({ server_id: "server-1", game_id: "game-1" }) },
    );
    expect(resp.status).toBe(404);
  });

  it("serves covers for public games without a session", async () => {
    mockAuth.mockResolvedValueOnce(null);
    mockDb.select
      .mockReturnValueOnce(mockQueryBuilder([{ public: true }])) // public flag lookup
      .mockReturnValueOnce(
        mockQueryBuilder([
          { name: "Gauntlet", sourceName: "gauntlet", thumbnailName: null, platform: "Arcade" },
        ]),
      ); // game row
    const previousFetch = global.fetch;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(Uint8Array.from(atob(PNG_1PX), (c) => c.charCodeAt(0)), {
          status: 200,
          headers: { "content-type": "image/png" },
        }),
      ),
    );
    const previousCoversDir = process.env.GV_COVERS_DIR;
    process.env.GV_COVERS_DIR = "/tmp/sc-covers-test";
    try {
      const { GET } = await import("@/app/api/covers/[server_id]/[game_id]/route");
      const resp = await GET(
        mkReq("http://localhost/api/covers/server-1/gauntlet"),
        { params: Promise.resolve({ server_id: "server-1", game_id: "gauntlet" }) },
      );
      expect(resp.status).toBe(200);
      expect(resp.headers.get("content-type")).toBe("image/png");
    } finally {
      if (previousCoversDir === undefined) delete process.env.GV_COVERS_DIR;
      else process.env.GV_COVERS_DIR = previousCoversDir;
      vi.unstubAllGlobals();
      (global.fetch as unknown) = previousFetch;
    }
  });
});
