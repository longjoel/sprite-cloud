import { beforeEach, describe, expect, it, vi } from "vitest";

const mockAuth = vi.fn();
const mockRemoveCoverAssets = vi.fn();
const mockDb = { select: vi.fn(), delete: vi.fn() };

function query(result: unknown) {
  const builder = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
  };
  return Object.assign(Promise.resolve(result), builder);
}

vi.mock("@/lib/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/cover-storage", () => ({ removeCoverAssets: mockRemoveCoverAssets }));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  mockAuth.mockResolvedValue({ user: { id: "admin-1" } });
  mockDb.delete.mockReturnValue(query([]));
  mockRemoveCoverAssets.mockResolvedValue(undefined);
});

describe("DELETE /api/servers/[server_id] cover cleanup", () => {
  const deleteRequest = () => new Request("http://localhost/api/servers/server-a", {
    method: "DELETE",
    headers: { cookie: "sc_csrf_token=t", "x-csrf-token": "t" },
  });

  it("rejects a destructive request without CSRF before reading server data", async () => {
    const { DELETE } = await import("@/app/api/servers/[server_id]/route");
    const response = await DELETE(new Request("http://localhost/api/servers/server-a", { method: "DELETE" }), {
      params: Promise.resolve({ server_id: "server-a" }),
    });
    expect(response.status).toBe(403);
    expect(mockDb.select).not.toHaveBeenCalled();
  });
  it("collects cover assets before deletion and garbage-collects them afterward", async () => {
    mockDb.select
      .mockReturnValueOnce(query([{ role: "admin" }]))
      .mockReturnValueOnce(query([{ assetId: "asset.webp", posterAssetId: "asset.poster.png" }]))
      .mockReturnValueOnce(query([]));
    const { DELETE } = await import("@/app/api/servers/[server_id]/route");

    const response = await DELETE(deleteRequest(), {
      params: Promise.resolve({ server_id: "server-a" }),
    });

    expect(response.status).toBe(200);
    expect(mockRemoveCoverAssets).toHaveBeenCalledWith(["asset.webp", "asset.poster.png"]);
  });

  it("does not turn a committed server deletion into an error when file cleanup fails", async () => {
    mockDb.select
      .mockReturnValueOnce(query([{ role: "admin" }]))
      .mockReturnValueOnce(query([{ assetId: "asset.webp", posterAssetId: "asset.poster.png" }]))
      .mockReturnValueOnce(query([]));
    mockRemoveCoverAssets.mockRejectedValue(new Error("storage unavailable"));
    const { DELETE } = await import("@/app/api/servers/[server_id]/route");

    const response = await DELETE(deleteRequest(), {
      params: Promise.resolve({ server_id: "server-a" }),
    });

    expect(response.status).toBe(200);
  });
});
