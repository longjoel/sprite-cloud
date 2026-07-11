import { describe, expect, it, vi } from "vitest";
import { loadXmbAuthenticatedData } from "@/lib/ui/xmb-authenticated-load";

describe("loadXmbAuthenticatedData", () => {
  it("uses one abort signal for both sequential requests", async () => {
    const controller = new AbortController();
    const fetcher = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ servers: [] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ games: [{ id: "game-1" }] }) });
    const setBootstrap = vi.fn();
    const setRecentIds = vi.fn();

    await loadXmbAuthenticatedData({
      signal: controller.signal,
      fetcher,
      setBootstrap,
      setRecentIds,
    });

    expect(fetcher).toHaveBeenNthCalledWith(1, "/api/client/bootstrap", { signal: controller.signal });
    expect(fetcher).toHaveBeenNthCalledWith(2, "/api/recent-plays", { signal: controller.signal });
    expect(setBootstrap).toHaveBeenCalledWith({ servers: [] });
    expect(setRecentIds).toHaveBeenCalledWith(["game-1"]);
  });

  it("does not update state or start the recent request after abort", async () => {
    const controller = new AbortController();
    const fetcher = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => {
        controller.abort();
        return { servers: [] };
      },
    });
    const setBootstrap = vi.fn();
    const setRecentIds = vi.fn();

    await loadXmbAuthenticatedData({
      signal: controller.signal,
      fetcher,
      setBootstrap,
      setRecentIds,
    });

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(setBootstrap).not.toHaveBeenCalled();
    expect(setRecentIds).not.toHaveBeenCalled();
  });

  it("does not update recent state when aborted while reading the response", async () => {
    const controller = new AbortController();
    const fetcher = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ servers: [] }) })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => {
          controller.abort();
          return { games: [{ id: "game-1" }] };
        },
      });
    const setRecentIds = vi.fn();

    await loadXmbAuthenticatedData({
      signal: controller.signal,
      fetcher,
      setBootstrap: vi.fn(),
      setRecentIds,
    });

    expect(setRecentIds).not.toHaveBeenCalled();
  });
});
