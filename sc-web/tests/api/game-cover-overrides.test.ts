import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { retroarchPlatform } from "@/lib/cover-candidates";

const mockAuth = vi.fn();
const mockPersistCover = vi.fn();
const mockRemoveCoverAssets = vi.fn();
const mockFetch = vi.fn();
const mockDb = {
  select: vi.fn(),
  insert: vi.fn(),
  delete: vi.fn(),
  transaction: vi.fn(),
};

function query(result: unknown) {
  const builder = {
    from: vi.fn().mockReturnThis(),
    innerJoin: vi.fn().mockReturnThis(),
    leftJoin: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    values: vi.fn().mockReturnThis(),
    onConflictDoUpdate: vi.fn().mockReturnThis(),
    returning: vi.fn().mockResolvedValue(result),
  };
  return Object.assign(Promise.resolve(result), builder);
}

vi.mock("@/lib/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/cover-storage", () => ({
  coverStorageCapability: () => ({ configured: true, maxBytes: 10_485_760 }),
  normalizeCover: async () => ({ bytes: Buffer.from("new"), poster: Buffer.from("poster"), mediaType: "image/webp", extension: "webp", width: 1, height: 1, animated: false, frameCount: 1 }),
  persistCover: mockPersistCover,
  readBoundedBody: async () => Buffer.from("upload"),
  removeCoverAssets: mockRemoveCoverAssets,
}));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.stubGlobal("fetch", mockFetch);
  process.env.GV_COVER_OVERRIDES_DIR = "/tmp/sc-cover-override-tests";
  process.env.AUTH_SECRET = "cover-test-secret";
  mockAuth.mockResolvedValue({ user: { id: "admin-1" } });
  mockDb.select.mockReturnValue(query([]));
  mockDb.insert.mockReturnValue(query([]));
  mockDb.delete.mockReturnValue(query([]));
  mockPersistCover.mockResolvedValue({ assetId: `${"a".repeat(64)}.webp`, posterAssetId: `${"a".repeat(64)}.poster.png` });
  mockRemoveCoverAssets.mockResolvedValue(undefined);
  mockFetch.mockResolvedValue(new Response("", { status: 404 }));
});

function request(path: string, init?: ConstructorParameters<typeof NextRequest>[1]) {
  return new NextRequest(`http://localhost${path}`, init);
}

const params = Promise.resolve({ server_id: "server-a", game_id: "game-a" });

describe("server-scoped cover override API", () => {
  it("maps Sprite Cloud arcade and PSP names to real RetroArch thumbnail systems", () => {
    expect(retroarchPlatform("Arcade")).toBe("FBNeo - Arcade Games");
    expect(retroarchPlatform("PSP")).toBe("Sony - PlayStation Portable");
    expect(retroarchPlatform("PC Engine")).toBe("NEC - PC Engine - TurboGrafx 16");
    expect(retroarchPlatform("Untrusted / platform")).toBeNull();
    expect(retroarchPlatform("toString")).toBeNull();
    expect(retroarchPlatform("__proto__")).toBeNull();
  });
  it("fails closed before reading an upload body when the caller is not an admin", async () => {
    mockDb.select.mockReturnValueOnce(query([{ role: "member" }]));
    const formData = vi.spyOn(NextRequest.prototype, "formData");
    const { POST } = await import("@/app/api/servers/[server_id]/games/[game_id]/cover/route");

    const response = await POST(request("/api/servers/server-a/games/game-a/cover", {
      method: "POST",
      headers: { cookie: "sc_csrf_token=t", "x-csrf-token": "t" },
    }), { params });

    expect(response.status).toBe(403);
    expect(formData).not.toHaveBeenCalled();
    formData.mockRestore();
  });

  it("returns signed, allowlisted RetroArch candidates from trusted game identity", async () => {
    mockDb.select
      .mockReturnValueOnce(query([{ role: "admin" }]))
      .mockReturnValueOnce(query([{
        name: "Cosmetic rename",
        sourceName: "Super Mario World (USA)",
        thumbnailName: "Super Mario World (USA)",
        canonicalTitle: "Super Mario World",
        region: "USA",
        platform: "SNES",
      }]));
    const { GET } = await import("@/app/api/servers/[server_id]/games/[game_id]/cover/candidates/route");

    const response = await GET(request("/api/servers/server-a/games/game-a/cover/candidates?type=boxart"), { params });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.candidates[0]).toMatchObject({ type: "boxart", title: "Super Mario World (USA)" });
    expect(body.candidates[0].id).toEqual(expect.any(String));
    expect(JSON.stringify(body)).not.toContain("thumbnails.libretro.com");
    expect(JSON.stringify(body)).not.toContain("Cosmetic rename");
  });

  it("searches the bounded RetroArch index instead of filtering only local title guesses", async () => {
    mockDb.select
      .mockReturnValueOnce(query([{ role: "admin" }]))
      .mockReturnValueOnce(query([{
        name: "Cosmetic rename",
        sourceName: "Super Mario World (USA)",
        thumbnailName: "Super Mario World (USA)",
        canonicalTitle: "Super Mario World",
        region: "USA",
        platform: "SNES",
      }]));
    mockFetch.mockResolvedValueOnce(new Response(`<!doctype html><table>
      <tr><td><a href="Legend%20of%20Zelda%2C%20The%20-%20A%20Link%20to%20the%20Past%20(USA).png">Zelda</a></td></tr>
      <tr><td><a href="Super%20Mario%20World%20(USA).png">Mario</a></td></tr>
      <tr><td><a href="notes.txt">not artwork</a></td></tr>
    </table>`, { status: 200, headers: { "content-type": "text/html;charset=UTF-8", "content-length": "512" } }));
    const { GET } = await import("@/app/api/servers/[server_id]/games/[game_id]/cover/candidates/route");

    const response = await GET(request("/api/servers/server-a/games/game-a/cover/candidates?type=boxart&q=Zelda"), { params });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.candidates).toHaveLength(1);
    expect(body.candidates[0]).toMatchObject({ type: "boxart", title: "Legend of Zelda, The - A Link to the Past (USA)" });
    expect(mockFetch).toHaveBeenCalledWith(
      "https://thumbnails.libretro.com/Nintendo%20-%20Super%20Nintendo%20Entertainment%20System/Named_Boxarts/",
      expect.objectContaining({ redirect: "error" }),
    );
  });

  it("decodes RetroArch HTML entities before matching and signing candidates", async () => {
    mockDb.select
      .mockReturnValueOnce(query([{ role: "admin" }]))
      .mockReturnValueOnce(query([{
        name: "Game", sourceName: "Game", thumbnailName: "Game",
        canonicalTitle: "Game", region: "USA", platform: "SNES",
      }]));
    mockFetch.mockResolvedValueOnce(new Response('<a href="Joe%20&amp;amp;%20Mac%20(USA).png">Joe</a>', {
      status: 200, headers: { "content-type": "text/html" },
    }));
    const { GET } = await import("@/app/api/servers/[server_id]/games/[game_id]/cover/candidates/route");

    const response = await GET(request("/api/servers/server-a/games/game-a/cover/candidates?type=boxart&q=Joe%20%26%20Mac"), { params });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.candidates).toHaveLength(1);
    expect(body.candidates[0].title).toBe("Joe & Mac (USA)");
  });

  it("rejects unsupported database platforms before fetching a provider index", async () => {
    mockDb.select
      .mockReturnValueOnce(query([{ role: "admin" }]))
      .mockReturnValueOnce(query([{
        name: "Game", sourceName: "Game", thumbnailName: "Game",
        canonicalTitle: "Game", region: null, platform: "Untrusted / platform",
      }]));
    const { GET } = await import("@/app/api/servers/[server_id]/games/[game_id]/cover/candidates/route");

    const response = await GET(request("/api/servers/server-a/games/game-a/cover/candidates?type=boxart&q=Game"), { params });

    expect(response.status).toBe(400);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("rejects inherited artwork type names before fetching a provider index", async () => {
    mockDb.select
      .mockReturnValueOnce(query([{ role: "admin" }]))
      .mockReturnValueOnce(query([{
        name: "Game", sourceName: "Game", thumbnailName: "Game",
        canonicalTitle: "Game", region: null, platform: "SNES",
      }]));
    const { GET } = await import("@/app/api/servers/[server_id]/games/[game_id]/cover/candidates/route");

    const response = await GET(request("/api/servers/server-a/games/game-a/cover/candidates?type=toString&q=Game"), { params });

    expect(response.status).toBe(400);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("fails closed when the RetroArch index exceeds the response bound", async () => {
    mockDb.select
      .mockReturnValueOnce(query([{ role: "admin" }]))
      .mockReturnValueOnce(query([{
        name: "Game", sourceName: "Game (USA)", thumbnailName: "Game (USA)",
        canonicalTitle: "Game", region: "USA", platform: "Nintendo 64",
      }]));
    mockFetch.mockResolvedValueOnce(new Response("<html></html>", {
      status: 200,
      headers: { "content-type": "text/html", "content-length": String(6 * 1024 * 1024 + 1) },
    }));
    const { GET } = await import("@/app/api/servers/[server_id]/games/[game_id]/cover/candidates/route");

    const response = await GET(request("/api/servers/server-a/games/game-a/cover/candidates?type=boxart&q=Game"), { params });

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({ error: "RetroArch artwork search is temporarily unavailable" });
  });

  it("requires CSRF before accepting a provider selection", async () => {
    const { PUT } = await import("@/app/api/servers/[server_id]/games/[game_id]/cover/route");
    const response = await PUT(request("/api/servers/server-a/games/game-a/cover", {
      method: "PUT",
      body: JSON.stringify({ candidateId: "opaque" }),
    }), { params });

    expect(response.status).toBe(403);
    expect(mockDb.insert).not.toHaveBeenCalled();
  });

  it("keeps a committed replacement valid when old-asset cleanup fails", async () => {
    mockDb.select
      .mockReturnValueOnce(query([{ role: "admin" }]))
      .mockReturnValueOnce(query([{ gameId: "game-a" }]));
    const tx = {
      execute: vi.fn().mockResolvedValue(undefined),
      select: vi.fn().mockReturnValue(query([{ assetId: "old.webp", posterAssetId: "old.poster.png" }])),
      insert: vi.fn().mockReturnValue(query([])),
    };
    mockDb.transaction.mockImplementation(async (callback: (value: typeof tx) => unknown) => callback(tx));
    mockRemoveCoverAssets.mockRejectedValueOnce(new Error("cleanup unavailable"));
    const { POST } = await import("@/app/api/servers/[server_id]/games/[game_id]/cover/route");

    const response = await POST(request("/api/servers/server-a/games/game-a/cover", {
      method: "POST",
      headers: { cookie: "sc_csrf_token=t", "x-csrf-token": "t" },
      body: Buffer.from("upload"),
    }), { params });

    expect(response.status).toBe(200);
    expect(mockRemoveCoverAssets).toHaveBeenCalledTimes(1);
    expect(mockRemoveCoverAssets).toHaveBeenCalledWith(["old.webp", "old.poster.png"]);
  });
});
