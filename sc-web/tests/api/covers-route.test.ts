import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

const mockAuth = vi.fn();
const mockDb = { select: vi.fn() };

function query(result: unknown) {
  const builder = {
    from: vi.fn().mockReturnThis(),
    innerJoin: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
  };
  return Object.assign(Promise.resolve(result), builder);
}

vi.mock("@/lib/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/db", () => ({ db: mockDb }));

let cacheDir: string;

beforeEach(async () => {
  vi.resetModules();
  cacheDir = await mkdtemp(join(tmpdir(), "sc-cover-test-"));
  process.env.GV_COVERS_DIR = cacheDir;
  mockAuth.mockReset().mockResolvedValue({ user: { id: "member-1" } });
  mockDb.select.mockReset().mockReturnValue(query([]));
});

afterEach(async () => {
  vi.unstubAllGlobals();
  delete process.env.GV_COVERS_DIR;
  await rm(cacheDir, { recursive: true, force: true });
});

function request() {
  return new NextRequest("http://localhost/api/covers/server-a/game-a");
}

describe("GET /api/covers/:server_id/:game_id", () => {
  it("rejects an unauthenticated request before catalog lookup", async () => {
    mockAuth.mockResolvedValue(null);

    const { GET } = await import("@/app/api/covers/[server_id]/[game_id]/route");
    const response = await GET(request(), { params: Promise.resolve({ server_id: "server-a", game_id: "game-a" }) });

    expect(response.status).toBe(401);
    expect(mockDb.select).not.toHaveBeenCalled();
  });

  it("does not disclose a game that is outside the caller membership", async () => {
    const { GET } = await import("@/app/api/covers/[server_id]/[game_id]/route");
    const response = await GET(request(), { params: Promise.resolve({ server_id: "other-server", game_id: "game-a" }) });

    expect(response.status).toBe(404);
  });

  it("uses trusted thumbnail_name before filename and does not allow shared caching", async () => {
    mockDb.select.mockReturnValue(query([{
      name: "User title",
      sourceName: "Wrong Filename",
      thumbnailName: "Super Mario World (USA)",
      platform: "SNES",
    }]));
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
    const fetchMock = vi.fn().mockResolvedValue(new Response(png, {
      status: 200,
      headers: { "content-type": "image/png", "content-length": String(png.length) },
    }));
    vi.stubGlobal("fetch", fetchMock);

    const { GET } = await import("@/app/api/covers/[server_id]/[game_id]/route");
    const response = await GET(request(), { params: Promise.resolve({ server_id: "server-a", game_id: "game-a" }) });

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(fetchMock.mock.calls[0][0]).toContain("Super%20Mario%20World%20%28USA%29.png");
  });
});
