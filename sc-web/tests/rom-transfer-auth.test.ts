/**
 * ROM transfer authorization tests.
 *
 * Tests the POST /api/servers/[server_id]/rom-transfers route.
 *
 * Run: npx vitest run tests/rom-transfer-auth.test.ts
 */

import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import { NextRequest } from "next/server";

// ── Mocks (must come before route import) ─────────────────────────────

// Mock DB
// Capture last insert values for test assertions
let lastInsertValues: Record<string, unknown> | undefined;

function mockQueryBuilder(returnValue: unknown) {
  const builder: Record<string, Mock> = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    innerJoin: vi.fn().mockReturnThis(),
    leftJoin: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    offset: vi.fn().mockReturnThis(),
    returning: vi.fn().mockReturnThis(),
    values: vi.fn(function (this: unknown, v: Record<string, unknown>) {
      lastInsertValues = v;
      return this;
    }),
    set: vi.fn().mockReturnThis(),
    groupBy: vi.fn().mockReturnThis(),
    for: vi.fn().mockReturnThis(),
  };
  return Object.assign(Promise.resolve(returnValue), builder);
}

const mockDb = {
  select: vi.fn(() => mockQueryBuilder([])),
  insert: vi.fn(() => mockQueryBuilder([{ id: "cmd-1" }])),
  update: vi.fn(() => mockQueryBuilder(undefined)),
  delete: vi.fn(() => mockQueryBuilder(undefined)),
};

vi.mock("@/lib/db", () => ({ db: mockDb }));

// Mock auth
const mockAuth = vi.fn();
vi.mock("@/lib/auth", () => ({ auth: mockAuth }));

// Mock rate limiter (pass through by default)
vi.mock("@/lib/rate-limit", () => ({
  applyRateLimit: vi.fn(() => null),
}));

// ── Helpers ───────────────────────────────────────────────────────────

function buildRequest(
  url: string,
  body?: unknown,
  opts?: { csrf?: string; cookieCsrf?: string; sessionUserId?: string | null },
): NextRequest {
  const headers = new Headers({ "Content-Type": "application/json" });
  if (opts?.csrf) {
    headers.set("x-csrf-token", opts.csrf);
  }
  if (opts?.cookieCsrf) {
    headers.set("cookie", `sc_csrf_token=${encodeURIComponent(opts.cookieCsrf)}`);
  }

  const req = new NextRequest(url, {
    method: "POST",
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  // Set up auth mock for this request
  mockAuth.mockResolvedValue(
    opts?.sessionUserId
      ? { user: { id: opts.sessionUserId, email: "test@example.com" } }
      : null,
  );

  return req;
}

// ── Tests ─────────────────────────────────────────────────────────────

// Dynamic import after mocks are set up
const { POST } = await import(
  "@/app/api/servers/[server_id]/rom-transfers/route"
);

beforeEach(() => {
  vi.clearAllMocks();
  lastInsertValues = undefined;

  // Default: admin membership
  mockDb.select.mockReturnValue(
    mockQueryBuilder([{ role: "admin", serverName: "Test Server" }]),
  );
  mockDb.insert.mockReturnValue(mockQueryBuilder([{ id: "cmd-1" }]));
});

describe("POST /api/servers/[server_id]/rom-transfers", () => {
  // ── Authentication ────────────────────────────────────────────────

  it("returns 401 when not signed in", async () => {
    const req = buildRequest(
      "http://localhost/api/servers/srv-1/rom-transfers",
      { basename: "game.nes", declared_size: 4096 },
      { sessionUserId: null },
    );

    const res = await POST(req, {
      params: Promise.resolve({ server_id: "srv-1" }),
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("sign in first");
  });

  it("returns 403 when CSRF token is missing", async () => {
    const req = buildRequest(
      "http://localhost/api/servers/srv-1/rom-transfers",
      { basename: "game.nes", declared_size: 4096 },
      { sessionUserId: "user-1", csrf: undefined, cookieCsrf: "abc" },
    );

    const res = await POST(req, {
      params: Promise.resolve({ server_id: "srv-1" }),
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe("csrf token invalid");
  });

  it("returns 403 when CSRF token does not match cookie", async () => {
    const req = buildRequest(
      "http://localhost/api/servers/srv-1/rom-transfers",
      { basename: "game.nes", declared_size: 4096 },
      { sessionUserId: "user-1", csrf: "wrong", cookieCsrf: "correct" },
    );

    const res = await POST(req, {
      params: Promise.resolve({ server_id: "srv-1" }),
    });
    expect(res.status).toBe(403);
  });

  // ── Authorization ─────────────────────────────────────────────────

  it("returns 403 when user is not a member of the server", async () => {
    mockDb.select.mockReturnValue(mockQueryBuilder([])); // no membership

    const req = buildRequest(
      "http://localhost/api/servers/srv-1/rom-transfers",
      { basename: "game.nes", declared_size: 4096 },
      { sessionUserId: "user-1", csrf: "t", cookieCsrf: "t" },
    );

    const res = await POST(req, {
      params: Promise.resolve({ server_id: "srv-1" }),
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe("server not found or not authorized");
  });

  it("returns 403 when user is a member but not admin", async () => {
    mockDb.select.mockReturnValue(
      mockQueryBuilder([{ role: "viewer", serverName: "Test Server" }]),
    );

    const req = buildRequest(
      "http://localhost/api/servers/srv-1/rom-transfers",
      { basename: "game.nes", declared_size: 4096 },
      { sessionUserId: "user-1", csrf: "t", cookieCsrf: "t" },
    );

    const res = await POST(req, {
      params: Promise.resolve({ server_id: "srv-1" }),
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe("administrator role required for ROM transfers");
  });

  // ── Body validation ───────────────────────────────────────────────

  it("returns 400 when body is not valid JSON", async () => {
    const headers = new Headers({
      "Content-Type": "application/json",
      "x-csrf-token": "t",
      cookie: "sc_csrf_token=t",
    });
    const req = new NextRequest(
      "http://localhost/api/servers/srv-1/rom-transfers",
      { method: "POST", headers, body: "not json" },
    );

    const res = await POST(req, {
      params: Promise.resolve({ server_id: "srv-1" }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("invalid json");
  });

  it("returns 400 when basename is missing", async () => {
    const req = buildRequest(
      "http://localhost/api/servers/srv-1/rom-transfers",
      { declared_size: 4096 },
      { sessionUserId: "user-1", csrf: "t", cookieCsrf: "t" },
    );

    const res = await POST(req, {
      params: Promise.resolve({ server_id: "srv-1" }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 when basename contains path separators", async () => {
    const req = buildRequest(
      "http://localhost/api/servers/srv-1/rom-transfers",
      { basename: "../etc/passwd", declared_size: 4096 },
      { sessionUserId: "user-1", csrf: "t", cookieCsrf: "t" },
    );

    const res = await POST(req, {
      params: Promise.resolve({ server_id: "srv-1" }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 when basename contains null bytes", async () => {
    const req = buildRequest(
      "http://localhost/api/servers/srv-1/rom-transfers",
      { basename: "game\x00.nes", declared_size: 4096 },
      { sessionUserId: "user-1", csrf: "t", cookieCsrf: "t" },
    );

    const res = await POST(req, {
      params: Promise.resolve({ server_id: "srv-1" }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 when declared_size is zero", async () => {
    const req = buildRequest(
      "http://localhost/api/servers/srv-1/rom-transfers",
      { basename: "game.nes", declared_size: 0 },
      { sessionUserId: "user-1", csrf: "t", cookieCsrf: "t" },
    );

    const res = await POST(req, {
      params: Promise.resolve({ server_id: "srv-1" }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 when declared_size is negative", async () => {
    const req = buildRequest(
      "http://localhost/api/servers/srv-1/rom-transfers",
      { basename: "game.nes", declared_size: -1 },
      { sessionUserId: "user-1", csrf: "t", cookieCsrf: "t" },
    );

    const res = await POST(req, {
      params: Promise.resolve({ server_id: "srv-1" }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 when declared_size is fractional", async () => {
    const req = buildRequest(
      "http://localhost/api/servers/srv-1/rom-transfers",
      { basename: "game.nes", declared_size: 1.5 },
      { sessionUserId: "user-1", csrf: "t", cookieCsrf: "t" },
    );

    const res = await POST(req, {
      params: Promise.resolve({ server_id: "srv-1" }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 when declared_size exceeds max", async () => {
    const req = buildRequest(
      "http://localhost/api/servers/srv-1/rom-transfers",
      { basename: "game.nes", declared_size: 3 * 1024 * 1024 * 1024 },
      { sessionUserId: "user-1", csrf: "t", cookieCsrf: "t" },
    );

    const res = await POST(req, {
      params: Promise.resolve({ server_id: "srv-1" }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 when platform_hint is invalid", async () => {
    const req = buildRequest(
      "http://localhost/api/servers/srv-1/rom-transfers",
      { basename: "game.nes", declared_size: 4096, platform_hint: "xbox360" },
      { sessionUserId: "user-1", csrf: "t", cookieCsrf: "t" },
    );

    const res = await POST(req, {
      params: Promise.resolve({ server_id: "srv-1" }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 when body has unexpected fields", async () => {
    const req = buildRequest(
      "http://localhost/api/servers/srv-1/rom-transfers",
      { basename: "game.nes", declared_size: 4096, evil: true },
      { sessionUserId: "user-1", csrf: "t", cookieCsrf: "t" },
    );

    const res = await POST(req, {
      params: Promise.resolve({ server_id: "srv-1" }),
    });
    expect(res.status).toBe(400);
  });

  // ── Success ────────────────────────────────────────────────────────

  it("returns 200 with transfer credentials for an admin", async () => {
    const req = buildRequest(
      "http://localhost/api/servers/srv-1/rom-transfers",
      { basename: "game.nes", declared_size: 4096, platform_hint: "nes" },
      { sessionUserId: "user-1", csrf: "t", cookieCsrf: "t" },
    );

    const res = await POST(req, {
      params: Promise.resolve({ server_id: "srv-1" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();

    // Transfer metadata
    expect(body.transfer_id).toBeDefined();
    expect(typeof body.transfer_id).toBe("string");
    expect(body.operation).toBe("upload");
    expect(body.expires_at).toBeDefined();

    // One-time capability secret
    expect(body.capability_secret).toBeDefined();
    expect(typeof body.capability_secret).toBe("string");
    expect(body.capability_secret.length).toBe(64); // 32 bytes hex

    // Command was queued
    expect(body.command_id).toBe("cmd-1");

    // Signaling bootstrap
    expect(body.signaling).toBeDefined();
    expect(body.signaling.server_id).toBe("srv-1");
    expect(body.signaling.transfer_id).toBe(body.transfer_id);

    // Verify the command payload contains hash, NOT the raw secret
    expect(lastInsertValues).toBeDefined();
    const payload = lastInsertValues?.payload as Record<string, unknown> | undefined;
    expect(payload).toBeDefined();
    expect(payload?.capability_hash).toBeDefined();
    expect(payload?.capability_hash).not.toBe(body.capability_secret);
    expect(typeof payload?.capability_hash).toBe("string");
    expect((payload?.capability_hash as string).length).toBe(64); // SHA-256 hex
    expect(payload?.authorized_user_id).toBe("user-1");
    expect(lastInsertValues?.serverId).toBe("srv-1");

    // Constraints are in the payload
    expect(payload?.constraints).toBeDefined();
    const constraints = payload?.constraints as Record<string, unknown>;
    expect(constraints.basename).toBe("game.nes");
    expect(constraints.declared_size).toBe(4096);
    expect(constraints.platform_hint).toBe("nes");

    // Capability secret is NOT in the payload
    expect(JSON.stringify(payload)).not.toContain(body.capability_secret as string);
  });

  it("accepts valid transfer without platform_hint", async () => {
    const req = buildRequest(
      "http://localhost/api/servers/srv-1/rom-transfers",
      { basename: "mystery.rom", declared_size: 1048576 },
      { sessionUserId: "user-1", csrf: "t", cookieCsrf: "t" },
    );

    const res = await POST(req, {
      params: Promise.resolve({ server_id: "srv-1" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.operation).toBe("upload");
    expect(body.capability_secret).toBeDefined();
  });

  it("generates unique capability secrets for each request", async () => {
    const secrets = new Set<string>();
    for (let i = 0; i < 3; i++) {
      const req = buildRequest(
        "http://localhost/api/servers/srv-1/rom-transfers",
        { basename: `game${i}.nes`, declared_size: 4096 },
        { sessionUserId: "user-1", csrf: "t", cookieCsrf: "t" },
      );

      const res = await POST(req, {
        params: Promise.resolve({ server_id: "srv-1" }),
      });
      const body = await res.json();
      secrets.add(body.capability_secret as string);
    }
    expect(secrets.size).toBe(3);
  });
});
