/**
 * gv-web API route tests.
 *
 * Tests every API route handler in isolation by importing the handler
 * functions directly and calling them with mock Requests.  DB and auth
 * are mocked so no Postgres instance is required.
 *
 * Run: npx vitest run tests/api/
 */

import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

// ── Mocks (must come before imports) ──────────────────────────────────

const mockDb = {
  select: vi.fn(),
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
    returning: vi.fn().mockReturnThis(),
    values: vi.fn().mockReturnThis(),
    set: vi.fn().mockReturnThis(),
    for: vi.fn().mockReturnThis(),
  };
  // When awaited, return the requested value
  builder.from.mockImplementation(() => {
    const self = { ...builder };
    // Make it thenable so await works
    return Object.assign(Promise.resolve(returnValue), self);
  });
  return builder;
}

// Make db methods return chainable builders
Object.assign(mockDb, {
  select: vi.fn(() => mockQueryBuilder([])),
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
const mockGenerateApiKey = vi.fn(() => "gvsk_test_api_key_12345");
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

vi.mock("@/lib/db/cleanup", () => ({ startCleanup: vi.fn() }));

// ── Helpers ────────────────────────────────────────────────────────────

function authHeader(token = "gvsk_test_api_key_12345") {
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
      cookie: `gv_csrf_token=${csrf}`,
    },
    body: JSON.stringify(body),
  };
}

/** Build a Request-like object with nextUrl for Next.js App Router handlers. */
function mkReq(url: string, init?: RequestInit) {
  const u = new URL(url);
  const req = new Request(url, init);
  return Object.assign(req, { nextUrl: u });
}

function resetAllMocks() {
  vi.clearAllMocks();
  mockAuth.mockResolvedValue({ user: { id: "user-1", name: "Tester", email: "test@example.com" } });
  mockVerifyBearerToken.mockResolvedValue({
    id: "server-1",
    userId: "user-1",
    name: "gv-server",
    apiKeyHash: "hashed_key",
  });
  mockVerifyAdminToken.mockResolvedValue({
    id: "server-1",
    userId: "user-1",
    name: "gv-server",
    apiKeyHash: "hashed_key",
  });
}

beforeEach(resetAllMocks);

// ── /api/auth/pair/generate ────────────────────────────────────────────

describe("POST /api/auth/pair/generate", () => {
  it("returns 401 when not signed in", async () => {
    mockAuth.mockResolvedValueOnce(null);
    const { POST } = await import("@/app/api/auth/pair/generate/route");
    const resp = await POST();
    expect(resp.status).toBe(401);
  });

  it("returns a pairing code when signed in", async () => {
    const { POST } = await import("@/app/api/auth/pair/generate/route");
    const resp = await POST();
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
    mockDb.select.mockReturnValue(
      mockQueryBuilder([{ code: "ABCD-EFGH", userId: "user-1", status: "pending", expiresAt: future }]),
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
    expect(body.api_key).toBe("gvsk_test_api_key_12345");
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
    // Mock the server membership check — returns admin role
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

    // Mock the insert chain: insert().values().returning()
    // returning() resolves to [{ id: "..." }]
    const insertBuilder = {
      values: vi.fn().mockReturnThis(),
      returning: vi.fn(() => Promise.resolve([{ id: "cmd-123" }])),
    };
    mockDb.insert.mockReturnValue(insertBuilder);

    const { POST } = await import("@/app/api/server/command/route");
    const req = mkReq("http://localhost/api/server/command", {
      ...jsonBodyWithCsrf({ server_id: "server-1", type: "start_game", payload: { game_id: "smw" } }),
    });
    const resp = await POST(req as any);
    expect(resp.status).toBe(201);
    const body = await resp.json();
    expect(body.worker_token).toBeTruthy();
    expect(body.worker_token.length).toBe(32); // 16 bytes hex = 32 chars
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
    const resp = await GET();
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
      const resp = await GET();
      expect(resp.status).toBe(200);
      const body = await resp.json();
      expect(body.iceTransportPolicy).toBe("relay");
    } finally {
      if (prev !== undefined) process.env.GV_ICE_TRANSPORT_POLICY = prev;
      else delete process.env.GV_ICE_TRANSPORT_POLICY;
    }
  });
});


// ── /api/health ────────────────────────────────────────────────────────

describe("GET /api/health", () => {
  it("returns ok when DB is reachable", async () => {
    mockDb.execute.mockResolvedValueOnce(undefined);
    const { GET } = await import("@/app/api/health/route");
    const resp = await GET();
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.status).toBe("ok");
  });

  it("returns 500 when DB is down", async () => {
    mockDb.execute.mockRejectedValueOnce(new Error("connection refused"));
    const { GET } = await import("@/app/api/health/route");
    const resp = await GET();
    expect(resp.status).toBe(500);
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
