import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { mkdtemp, rm, writeFile } from "fs/promises";
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
  process.env.GV_COVER_OVERRIDES_DIR = cacheDir;
  mockAuth.mockReset().mockResolvedValue({ user: { id: "member-1" } });
  mockDb.select.mockReset().mockReturnValue(query([]));
});

afterEach(async () => {
  vi.unstubAllGlobals();
  delete process.env.GV_COVERS_DIR;
  delete process.env.GV_COVER_OVERRIDES_DIR;
  await rm(cacheDir, { recursive: true, force: true });
});

function request(query = "") {
  return new NextRequest(`http://localhost/api/covers/server-a/game-a${query}`);
}

describe("GET /api/covers/:server_id/:game_id", () => {
  it("fails closed: unauthenticated + non-public game → 404 (no disclosure)", async () => {
    mockAuth.mockResolvedValue(null);

    const { GET } = await import("@/app/api/covers/[server_id]/[game_id]/route");
    const response = await GET(request(), { params: Promise.resolve({ server_id: "server-a", game_id: "game-a" }) });

    // The public carve-out (#762) allows unauthenticated covers only for
    // games flagged `public`; everything else is 404 — indistinguishable
    // from a nonexistent game.
    expect(response.status).toBe(404);
    expect(mockDb.select).toHaveBeenCalled();
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

  it("serves a valid cover even when its cache directory cannot be created", async () => {
    mockDb.select.mockReturnValue(query([{
      name: "Super Mario World (USA)",
      sourceName: null,
      thumbnailName: null,
      platform: "SNES",
    }]));
    await rm(cacheDir, { recursive: true, force: true });
    await writeFile(cacheDir, "not a directory");
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(png, {
      status: 200,
      headers: { "content-type": "image/png", "content-length": String(png.length) },
    })));

    const { GET } = await import("@/app/api/covers/[server_id]/[game_id]/route");
    const response = await GET(request(), { params: Promise.resolve({ server_id: "server-a", game_id: "game-a" }) });

    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(png);
  });

  it("serves the static poster when the client explicitly requests reduced-motion artwork", async () => {
    const animated = Buffer.from("animated-gif");
    const poster = Buffer.from("static-poster");
    await writeFile(join(cacheDir, `${"a".repeat(64)}.gif`), animated);
    await writeFile(join(cacheDir, `${"a".repeat(64)}.poster.png`), poster);
    mockDb.select
      .mockReturnValueOnce(query([{ name: "Game", sourceName: "Game", thumbnailName: "Game", platform: "SNES" }]))
      .mockReturnValueOnce(query([{
        assetId: `${"a".repeat(64)}.gif`,
        posterAssetId: `${"a".repeat(64)}.poster.png`,
        mediaType: "image/gif",
      }]));
    const { GET } = await import("@/app/api/covers/[server_id]/[game_id]/route");

    const response = await GET(request("?poster=1"), { params: Promise.resolve({ server_id: "server-a", game_id: "game-a" }) });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await response.arrayBuffer())).toEqual(poster);
  });
});
