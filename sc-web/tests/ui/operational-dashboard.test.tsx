// @vitest-environment jsdom

import { act } from "react";
import React from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import DashboardClient from "@/app/servers/DashboardClient";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

const admin = {
  id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
  name: "Arcade Host",
  lastSeenAt: new Date().toISOString(),
  role: "admin",
};
const member = {
  id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
  name: "Shared Library",
  lastSeenAt: null,
  role: "member",
};

const summaries = {
  servers: [
    {
      serverId: admin.id,
      role: "admin",
      health: "online",
      lastSeenAt: admin.lastSeenAt,
      installedVersion: "0.11.3",
      activeSessionCount: 1,
      gameCount: 426,
      lan: { configured: true, healthUrls: [] },
      activeUpgrade: null,
    },
    {
      serverId: member.id,
      role: "member",
      health: "offline",
      lastSeenAt: null,
      installedVersion: null,
      activeSessionCount: 0,
      gameCount: 18,
      lan: { configured: false, healthUrls: [] },
      activeUpgrade: null,
    },
  ],
};

describe("operational server dashboard", () => {
  let root: ReturnType<typeof createRoot> | null = null;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/api/servers/summary") {
        return { ok: true, json: async () => summaries } as Response;
      }
      if (url.includes("/metadata")) {
        return { ok: true, json: async () => ({ metadata: {} }) } as Response;
      }
      if (url.includes("/core-overrides")) {
        return { ok: true, json: async () => ({ overrides: {} }) } as Response;
      }
      return { ok: true, json: async () => ({}) } as Response;
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(async () => {
    if (root) await act(async () => root?.unmount());
    root = null;
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  async function render() {
    const host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => root?.render(<DashboardClient memberships={[admin, member]} />));
    await act(async () => { await Promise.resolve(); });
    return host;
  }

  it("renders one responsive card tree with operational metrics and attention first", async () => {
    const host = await render();

    expect(host.querySelectorAll("[data-server-card]")).toHaveLength(2);
    expect(host.querySelector(".sc-dashboard-table")).toBeNull();
    expect(host.querySelector(".sc-dashboard-cards")).toBeNull();
    expect(host.textContent).toContain("Attention required");
    expect(host.textContent).toContain("426 games");
    expect(host.textContent).toContain("1 active session");
    expect(host.textContent).toContain("sc-server 0.11.3");
    expect(host.querySelectorAll("[data-server-card]")[0].textContent).toContain("Shared Library");
  });

  it("shows admin operations without rendering disabled management arrays for members", async () => {
    const host = await render();
    const cards = host.querySelectorAll<HTMLElement>("[data-server-card]");
    const adminCard = Array.from(cards).find((card) => card.textContent?.includes("Arcade Host"))!;
    const memberCard = Array.from(cards).find((card) => card.textContent?.includes("Shared Library"))!;

    expect(adminCard.textContent).toContain("Finish active game to update");
    expect(adminCard.textContent).toContain("Server settings");
    expect(memberCard.textContent).not.toContain("Invite user");
    expect(memberCard.textContent).not.toContain("Remove server");
    expect(memberCard.textContent).not.toContain("Server settings");
    expect(memberCard.querySelectorAll("button:disabled")).toHaveLength(0);
  });

  it("opens settings without fetching the game catalog or per-game flags", async () => {
    const host = await render();
    const settings = Array.from(host.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent?.includes("Server settings"));
    expect(settings).toBeDefined();

    await act(async () => settings!.click());
    await act(async () => { await Promise.resolve(); });

    const urls = fetchMock.mock.calls.map(([input]) => String(input));
    expect(urls.some((url) => url.endsWith("/games"))).toBe(false);
    expect(urls.some((url) => url.includes("/game-flags/"))).toBe(false);
    expect(host.textContent).not.toContain("Arcade & Free Play");
  });

  it("confirms restart disruption before submitting an update", async () => {
    summaries.servers[0] = { ...summaries.servers[0], activeSessionCount: 0 };
    const host = await render();
    const adminCard = Array.from(host.querySelectorAll<HTMLElement>("[data-server-card]"))
      .find((card) => card.textContent?.includes("Arcade Host"))!;
    const update = Array.from(adminCard.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent?.includes("Update server"));
    expect(update).toBeDefined();

    await act(async () => update!.click());

    const dialog = document.body.querySelector('[role="dialog"]');
    expect(dialog?.textContent).toContain("The server will restart");
    expect(fetchMock).not.toHaveBeenCalledWith(
      "/api/servers/server-a/upgrade",
      expect.anything(),
    );
  });

  it("renders unavailable summaries as unknown rather than offline", async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, json: async () => ({}) } as Response);
    const host = await render();

    expect(host.textContent).toContain("Unable to load server health.");
    expect(host.textContent).toContain("Unknown");
    expect(host.textContent).toContain("Status unavailable");
    expect(host.textContent).not.toContain("Attention required");
  });

  it("revalidates operational summaries while the dashboard remains open", async () => {
    vi.useFakeTimers();
    try {
      const host = await render();
      const initialSummaryCalls = fetchMock.mock.calls.filter(([input]) => String(input) === "/api/servers/summary").length;

      await act(async () => {
        await vi.advanceTimersByTimeAsync(30_000);
      });

      const summaryCalls = fetchMock.mock.calls.filter(([input]) => String(input) === "/api/servers/summary").length;
      expect(summaryCalls).toBe(initialSummaryCalls + 1);
      expect(host.textContent).toContain("Server health");
    } finally {
      vi.useRealTimers();
    }
  });
});
