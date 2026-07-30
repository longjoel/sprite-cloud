/**
 * ROM transfer SDP offer signaling tests.
 *
 * Tests POST /api/servers/[server_id]/rom-transfers/[transfer_id]/offer.
 *
 * Run: npx vitest run tests/rom-transfer-signaling.test.ts
 */

import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import { NextRequest } from "next/server";
import crypto from "crypto";

// ── Mocks ─────────────────────────────────────────────────────────────

function mockQueryBuilder(returnValue: unknown) {
  const builder: Record<string, Mock> = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    innerJoin: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    set: vi.fn().mockReturnThis(),
    returning: vi.fn().mockReturnThis(),
  };
  return Object.assign(Promise.resolve(returnValue), builder);
}

const mockDb = {
  select: vi.fn(() => mockQueryBuilder([])),
  update: vi.fn(() => mockQueryBuilder([{ id: "cmd-1" }])),
};

vi.mock("@/lib/db", () => ({ db: mockDb }));

vi.mock("@/lib/rate-limit", () => ({
  applyRateLimit: vi.fn(() => null),
}));

// ── Helpers ───────────────────────────────────────────────────────────

function buildRequest(
  url: string,
  body?: unknown,
  opts?: { csrf?: string; cookieCsrf?: string },
): NextRequest {
  const headers = new Headers({ "Content-Type": "application/json" });
  if (opts?.csrf) headers.set("x-csrf-token", opts.csrf);
  if (opts?.cookieCsrf) headers.set("cookie", `sc_csrf_token=${encodeURIComponent(opts.cookieCsrf ?? "")}`);

  return new NextRequest(url, {
    method: "POST",
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

const { POST } = await import(
  "@/app/api/servers/[server_id]/rom-transfers/[transfer_id]/offer/route"
);

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.update.mockReturnValue(mockQueryBuilder([{ id: "cmd-1" }]));
});

// ── Tests ─────────────────────────────────────────────────────────────

describe("POST /api/servers/[server_id]/rom-transfers/[transfer_id]/offer", () => {
  // ── CSRF ──────────────────────────────────────────────────────────

  it("returns 403 when CSRF token is missing", async () => {
    const req = buildRequest(
      "http://localhost/api/servers/srv-1/rom-transfers/xfer-1/offer",
      { sdp: "v=0...", capability_secret: "sec" },
      { csrf: undefined, cookieCsrf: "t" },
    );
    const res = await POST(req, {
      params: Promise.resolve({ server_id: "srv-1", transfer_id: "xfer-1" }),
    });
    expect(res.status).toBe(403);
  });

  // ── Body validation ───────────────────────────────────────────────

  it("returns 400 when body is not JSON", async () => {
    const headers = new Headers({
      "Content-Type": "application/json",
      "x-csrf-token": "t",
      cookie: "sc_csrf_token=t",
    });
    const req = new NextRequest(
      "http://localhost/api/servers/srv-1/rom-transfers/xfer-1/offer",
      { method: "POST", headers, body: "not json" },
    );
    const res = await POST(req, {
      params: Promise.resolve({ server_id: "srv-1", transfer_id: "xfer-1" }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 when sdp is missing", async () => {
    const req = buildRequest(
      "http://localhost/api/servers/srv-1/rom-transfers/xfer-1/offer",
      { capability_secret: "sec" },
      { csrf: "t", cookieCsrf: "t" },
    );
    const res = await POST(req, {
      params: Promise.resolve({ server_id: "srv-1", transfer_id: "xfer-1" }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 when sdp is empty", async () => {
    const req = buildRequest(
      "http://localhost/api/servers/srv-1/rom-transfers/xfer-1/offer",
      { sdp: "", capability_secret: "sec" },
      { csrf: "t", cookieCsrf: "t" },
    );
    const res = await POST(req, {
      params: Promise.resolve({ server_id: "srv-1", transfer_id: "xfer-1" }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 when capability_secret is missing", async () => {
    const req = buildRequest(
      "http://localhost/api/servers/srv-1/rom-transfers/xfer-1/offer",
      { sdp: "v=0..." },
      { csrf: "t", cookieCsrf: "t" },
    );
    const res = await POST(req, {
      params: Promise.resolve({ server_id: "srv-1", transfer_id: "xfer-1" }),
    });
    expect(res.status).toBe(400);
  });

  // ── Transfer not found ────────────────────────────────────────────

  it("returns 404 when no matching prepared command exists", async () => {
    mockDb.select.mockReturnValue(mockQueryBuilder([]));

    const req = buildRequest(
      "http://localhost/api/servers/srv-1/rom-transfers/xfer-1/offer",
      { sdp: "v=0...", capability_secret: "sec" },
      { csrf: "t", cookieCsrf: "t" },
    );
    const res = await POST(req, {
      params: Promise.resolve({ server_id: "srv-1", transfer_id: "xfer-1" }),
    });
    expect(res.status).toBe(404);
  });

  // ── Capability verification ───────────────────────────────────────

  function makeCommand(opts: {
    id?: string;
    transfer_id?: string;
    capability_secret?: string;
    expires_at?: string;
  }) {
    const secret = opts.capability_secret ?? "the-real-secret";
    const hash = crypto.createHash("sha256").update(secret).digest("hex");
    return {
      id: opts.id ?? "cmd-1",
      type: "rom_transfer",
      status: "preparing",
      serverId: "srv-1",
      payload: {
        transfer_id: opts.transfer_id ?? "xfer-1",
        operation: "upload",
        capability_hash: hash,
        constraints: {
          basename: "game.nes",
          declared_size: 4096,
          platform_hint: "nes",
        },
        expires_at: opts.expires_at ?? new Date(Date.now() + 300_000).toISOString(),
      },
    };
  }

  it("returns 403 when capability_secret does not match hash", async () => {
    const cmd = makeCommand({ capability_secret: "correct-secret" });
    mockDb.select.mockReturnValue(mockQueryBuilder([cmd]));

    const req = buildRequest(
      "http://localhost/api/servers/srv-1/rom-transfers/xfer-1/offer",
      { sdp: "v=0...", capability_secret: "wrong-secret" },
      { csrf: "t", cookieCsrf: "t" },
    );
    const res = await POST(req, {
      params: Promise.resolve({ server_id: "srv-1", transfer_id: "xfer-1" }),
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe("invalid capability");
  });

  it("returns 200 and activates command when capability is correct", async () => {
    const secret = "the-real-secret";
    const cmd = makeCommand({ capability_secret: secret });
    mockDb.select.mockReturnValue(mockQueryBuilder([cmd]));
    mockDb.update.mockReturnValue(mockQueryBuilder([{ id: "cmd-1" }]));

    const req = buildRequest(
      "http://localhost/api/servers/srv-1/rom-transfers/xfer-1/offer",
      { sdp: "v=0\r\no=...\r\n...", capability_secret: secret },
      { csrf: "t", cookieCsrf: "t" },
    );
    const res = await POST(req, {
      params: Promise.resolve({ server_id: "srv-1", transfer_id: "xfer-1" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.command_id).toBe("cmd-1");
    expect(body.transfer_id).toBe("xfer-1");
  });

  it("rejects a concurrent capability activation that lost the atomic claim", async () => {
    const secret = "the-real-secret";
    const cmd = makeCommand({ capability_secret: secret });
    mockDb.select.mockReturnValue(mockQueryBuilder([cmd]));
    mockDb.update.mockReturnValue(mockQueryBuilder([]));

    const req = buildRequest(
      "http://localhost/api/servers/srv-1/rom-transfers/xfer-1/offer",
      { sdp: "v=0...", capability_secret: secret },
      { csrf: "t", cookieCsrf: "t" },
    );
    const res = await POST(req, {
      params: Promise.resolve({ server_id: "srv-1", transfer_id: "xfer-1" }),
    });

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "transfer already activated" });
  });

  // ── Expiry ─────────────────────────────────────────────────────────

  it("returns 410 when capability has expired", async () => {
    const secret = "expired-secret";
    const cmd = makeCommand({
      capability_secret: secret,
      expires_at: new Date(Date.now() - 60_000).toISOString(), // 1 minute ago
    });
    mockDb.select.mockReturnValue(mockQueryBuilder([cmd]));

    const req = buildRequest(
      "http://localhost/api/servers/srv-1/rom-transfers/xfer-1/offer",
      { sdp: "v=0...", capability_secret: secret },
      { csrf: "t", cookieCsrf: "t" },
    );
    const res = await POST(req, {
      params: Promise.resolve({ server_id: "srv-1", transfer_id: "xfer-1" }),
    });
    expect(res.status).toBe(410);
    const body = await res.json();
    expect(body.error).toBe("transfer capability expired");
  });

  // ── Server ID mismatch ────────────────────────────────────────────

  it("returns 404 when command exists for different server", async () => {
    // Command is for srv-1, but request is for srv-2
    const cmd = makeCommand({ capability_secret: "sec" });
    mockDb.select.mockReturnValue(mockQueryBuilder([])); // no match for srv-2

    const req = buildRequest(
      "http://localhost/api/servers/srv-2/rom-transfers/xfer-1/offer",
      { sdp: "v=0...", capability_secret: "sec" },
      { csrf: "t", cookieCsrf: "t" },
    );
    const res = await POST(req, {
      params: Promise.resolve({ server_id: "srv-2", transfer_id: "xfer-1" }),
    });
    expect(res.status).toBe(404);
  });

  // ── SDP activation produces 200 ───────────────────────────────────

  it("returns 200 with command_id when SDP offer is accepted", async () => {
    const secret = "sdp-secret";
    const cmd = makeCommand({ capability_secret: secret });
    mockDb.select.mockReturnValue(mockQueryBuilder([cmd]));
    mockDb.update.mockReturnValue(mockQueryBuilder([{ id: "cmd-1" }]));

    const sdp = "v=0\r\no=browser 123 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n";
    const req = buildRequest(
      "http://localhost/api/servers/srv-1/rom-transfers/xfer-1/offer",
      { sdp, capability_secret: secret },
      { csrf: "t", cookieCsrf: "t" },
    );
    const res = await POST(req, {
      params: Promise.resolve({ server_id: "srv-1", transfer_id: "xfer-1" }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.command_id).toBe("cmd-1");
    expect(body.transfer_id).toBe("xfer-1");
  });
});
