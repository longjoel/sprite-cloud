import { describe, expect, it, vi } from "vitest";
import { loadXmbAuthenticatedData } from "@/lib/ui/xmb-authenticated-load";

describe("loadXmbAuthenticatedData", () => {
  it("fetches only bootstrap and merges canonical favorites, pins, and recent", async () => {
    const controller = new AbortController();
    const fetcher = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        servers: [{ id: "s1", name: "Server 1" }],
        library: {
          totalGames: 42,
          pinnedCount: 3,
          favoriteIds: ["game-a", "game-c"],
          pinnedIds: ["game-a", "game-b"],
          recentGames: [
            { id: "game-c", playedAt: "2026-07-13T10:00:00.000Z" },
            { id: "game-a", playedAt: "2026-07-12T08:00:00.000Z" },
          ],
        },
      }),
    });
    const setBootstrap = vi.fn();
    const setFavoriteIds = vi.fn();
    const setPinnedIds = vi.fn();
    const setRecentGames = vi.fn();

    await loadXmbAuthenticatedData({
      signal: controller.signal,
      fetcher,
      setBootstrap,
      setFavoriteIds,
      setPinnedIds,
      setRecentGames,
    });

    // Only one fetch — bootstrap now carries canonical data
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith("/api/client/bootstrap", { signal: controller.signal });

    expect(setBootstrap).toHaveBeenCalledWith(
      expect.objectContaining({
        servers: [{ id: "s1", name: "Server 1" }],
        library: expect.objectContaining({ totalGames: 42, pinnedCount: 3 }),
      }),
    );

    expect(setFavoriteIds).toHaveBeenCalledWith(new Set(["game-a", "game-c"]));
    expect(setPinnedIds).toHaveBeenCalledWith(new Set(["game-a", "game-b"]));
    expect(setRecentGames).toHaveBeenCalledWith([
      { id: "game-c", playedAt: "2026-07-13T10:00:00.000Z" },
      { id: "game-a", playedAt: "2026-07-12T08:00:00.000Z" },
    ]);
  });

  it("handles missing canonical fields gracefully (empty sets/arrays)", async () => {
    const controller = new AbortController();
    const fetcher = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        servers: [],
        library: { totalGames: 0, pinnedCount: 0 },
      }),
    });
    const setBootstrap = vi.fn();
    const setFavoriteIds = vi.fn();
    const setPinnedIds = vi.fn();
    const setRecentGames = vi.fn();

    await loadXmbAuthenticatedData({
      signal: controller.signal,
      fetcher,
      setBootstrap,
      setFavoriteIds,
      setPinnedIds,
      setRecentGames,
    });

    expect(setFavoriteIds).toHaveBeenCalledWith(new Set());
    expect(setPinnedIds).toHaveBeenCalledWith(new Set());
    expect(setRecentGames).toHaveBeenCalledWith([]);
  });

  it("does not update state after abort", async () => {
    const controller = new AbortController();
    const fetcher = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => {
        controller.abort();
        return { servers: [] };
      },
    });
    const setBootstrap = vi.fn();
    const setFavoriteIds = vi.fn();

    await loadXmbAuthenticatedData({
      signal: controller.signal,
      fetcher,
      setBootstrap,
      setFavoriteIds,
      setPinnedIds: vi.fn(),
      setRecentGames: vi.fn(),
    });

    expect(setBootstrap).not.toHaveBeenCalled();
    expect(setFavoriteIds).not.toHaveBeenCalled();
  });

  it("preserves recent game order from the server (most recent first)", async () => {
    const controller = new AbortController();
    const recentGames = [
      { id: "newest", playedAt: "2026-07-13T23:00:00.000Z" },
      { id: "older", playedAt: "2026-07-10T01:00:00.000Z" },
    ];
    const fetcher = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        servers: [],
        library: {
          totalGames: 2,
          pinnedCount: 0,
          recentGames,
        },
      }),
    });
    const setRecentGames = vi.fn();

    await loadXmbAuthenticatedData({
      signal: controller.signal,
      fetcher,
      setBootstrap: vi.fn(),
      setFavoriteIds: vi.fn(),
      setPinnedIds: vi.fn(),
      setRecentGames,
    });

    expect(setRecentGames).toHaveBeenCalledWith(recentGames);
  });
});
