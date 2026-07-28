import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { loadXmbAuthenticatedData } from "@/lib/ui/xmb-authenticated-load";

describe("loadXmbAuthenticatedData", () => {
  it("uses the same browser-local Favorites migration as the main library", () => {
    const source = readFileSync("app/xmb/page.tsx", "utf8");
    expect(source).toContain("migrateLegacyPinsToFavorites(localStorage");
    expect(source).toContain("favorite: isSavedGameFavorite(favoriteIds, game)");
    expect(source).not.toContain("Boolean(game.favorite ?? game.favorited)");
  });

  it("loads cloud account and server metadata without library state", async () => {
    const controller = new AbortController();
    const bootstrap = {
      servers: [{ id: "s1", name: "Server 1" }],
      library: null,
    };
    const fetcher = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => bootstrap,
    });
    const setBootstrap = vi.fn();

    await loadXmbAuthenticatedData({
      signal: controller.signal,
      fetcher,
      setBootstrap,
    });

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith("/api/client/bootstrap", { signal: controller.signal });
    expect(setBootstrap).toHaveBeenCalledWith(bootstrap);
  });

  it("does not update state after abort", async () => {
    const controller = new AbortController();
    const fetcher = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => {
        controller.abort();
        return { servers: [], library: null };
      },
    });
    const setBootstrap = vi.fn();

    await loadXmbAuthenticatedData({ signal: controller.signal, fetcher, setBootstrap });

    expect(setBootstrap).not.toHaveBeenCalled();
  });
});
