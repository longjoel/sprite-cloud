// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// We test the launch-game module functions in isolation.
// The module under test lives at lib/ui/launch-game.ts (doesn't exist yet — RED phase).

describe("launch-game utility", () => {
  describe("buildPlayerPath", () => {
    it("returns the canonical path for a given short code", async () => {
      // Dynamic import so the module doesn't have to exist yet at parse time
      const { buildPlayerPath } = await import("@/lib/ui/launch-game");
      expect(buildPlayerPath("abc123")).toBe("/p/abc123");
    });

    it("appends shell=xmb query param when shell is specified", async () => {
      const { buildPlayerPath } = await import("@/lib/ui/launch-game");
      expect(buildPlayerPath("abc123", "xmb")).toBe("/p/abc123?shell=xmb");
    });

    it("does not append shell param when shell is empty or undefined", async () => {
      const { buildPlayerPath } = await import("@/lib/ui/launch-game");
      expect(buildPlayerPath("abc123", "")).toBe("/p/abc123");
      expect(buildPlayerPath("abc123", undefined)).toBe("/p/abc123");
    });
  });

  describe("createLaunchShortCode", () => {
    const gameId = "game-1";
    const serverId = "server-a";
    const hostToken = "host-token-123";
    const expectedCode = "xyz789";

    beforeEach(() => {
      vi.stubGlobal("fetch", vi.fn());
      vi.stubGlobal("crypto", {
        randomUUID: () => "mocked-uuid",
      });
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it("calls /api/room/shorten with correct payload and returns the code", async () => {
      const { createLaunchShortCode } = await import("@/lib/ui/launch-game");

      (fetch as any).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ code: expectedCode }),
      });

      const abort = new AbortController();
      const code = await createLaunchShortCode({
        gameId,
        serverId,
        hostToken,
        signal: abort.signal,
      });

      expect(code).toBe(expectedCode);
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(fetch).toHaveBeenCalledWith("/api/room/shorten", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          game_id: gameId,
          host_token: hostToken,
          server_id: serverId,
        }),
        signal: abort.signal,
      });
    });

    it("throws when the API returns a non-ok status", async () => {
      const { createLaunchShortCode } = await import("@/lib/ui/launch-game");

      (fetch as any).mockResolvedValueOnce({
        ok: false,
        status: 500,
        json: () => Promise.resolve({ error: "internal" }),
      });

      await expect(
        createLaunchShortCode({ gameId, serverId, hostToken }),
      ).rejects.toThrow("Could not create a play link");
    });

    it("throws when the response code is missing or empty", async () => {
      const { createLaunchShortCode } = await import("@/lib/ui/launch-game");

      // Missing code field
      (fetch as any).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({}),
      });
      await expect(
        createLaunchShortCode({ gameId, serverId, hostToken }),
      ).rejects.toThrow("The play link response did not include a code");

      // Empty code
      (fetch as any).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ code: "" }),
      });
      await expect(
        createLaunchShortCode({ gameId, serverId, hostToken }),
      ).rejects.toThrow("The play link response did not include a code");
    });

    it("generates a host token when none is provided", async () => {
      const { createLaunchShortCode } = await import("@/lib/ui/launch-game");

      (fetch as any).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ code: expectedCode }),
      });

      await createLaunchShortCode({ gameId, serverId });

      expect(fetch).toHaveBeenCalledWith("/api/room/shorten", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          game_id: gameId,
          host_token: "mocked-uuid",
          server_id: serverId,
        }),
        signal: undefined,
      });
    });
  });
});
