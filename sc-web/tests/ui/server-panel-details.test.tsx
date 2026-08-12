// @vitest-environment jsdom

import { act } from "react";
import React from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ServerPanel from "@/app/servers/ServerPanel";

describe("server panel details", () => {
  let root: ReturnType<typeof createRoot> | null = null;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/metadata")) {
        return { ok: true, json: async () => ({ metadata: { version: "0.11.3" } }) } as Response;
      }
      if (url.endsWith("/core-overrides")) {
        return { ok: true, json: async () => ({ overrides: {} }) } as Response;
      }
      return { ok: true, json: async () => ({ games: [{ game_id: "pac-man", name: "Pac-Man", platform: "Arcade" }] }) } as Response;
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(async () => {
    if (root) await act(async () => root?.unmount());
    root = null;
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  it("loads only diagnostic metadata and core overrides", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);

    await act(async () => root?.render(<ServerPanel serverId="server-1" />));
    await act(async () => { await Promise.resolve(); });

    const urls = fetchMock.mock.calls.map(([input]) => String(input));
    expect(urls).toEqual([
      "/api/servers/server-1/metadata",
      "/api/servers/server-1/core-overrides",
    ]);
    expect(host.textContent).toContain("Runtime");
    expect(host.textContent).toContain("Core overrides");
    expect(host.textContent).not.toContain("Arcade & Free Play");
    expect(host.textContent).not.toContain("Update server");
  });
});
