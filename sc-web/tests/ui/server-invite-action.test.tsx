// @vitest-environment jsdom

import { act } from "react";
import React from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import DashboardClient from "@/app/servers/DashboardClient";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

const memberships = [
  { id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", name: "Living Room", lastSeenAt: new Date().toISOString(), role: "admin" },
  { id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", name: "Basement", lastSeenAt: null, role: "member" },
];

describe("server invitation action", () => {
  let root: ReturnType<typeof createRoot> | null = null;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
      .IS_REACT_ACT_ENVIRONMENT = true;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/api/servers/summary") {
        return {
          ok: true,
          json: async () => ({
            servers: memberships.map((membership) => ({
              serverId: membership.id,
              role: membership.role,
              health: membership.lastSeenAt ? "online" : "offline",
              lastSeenAt: membership.lastSeenAt,
              installedVersion: "0.11.3",
              activeSessionCount: 0,
              gameCount: 12,
              lan: { configured: false, healthUrls: [] },
              activeUpgrade: null,
            })),
          }),
        } as Response;
      }
      const body =
        url.includes("/members") || url.includes("/invites")
          ? init?.method === "POST"
            ? { invite: { url: "/invite/test-capability" } }
            : { invites: [] }
          : { metadata: null };
      return { ok: true, json: async () => body } as Response;
    }));
  });

  afterEach(async () => {
    if (root) await act(async () => root?.unmount());
    root = null;
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  it("shows management only for administrators", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => root?.render(<DashboardClient memberships={memberships} />));

    await act(async () => { await Promise.resolve(); });

    expect(host.querySelector('[data-server-card="aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"]')).toBeTruthy();
    expect(host.querySelector('[data-server-card="bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"]')).toBeTruthy();
    expect(host.querySelector('button[aria-label="Manage Living Room"]')).toBeTruthy();
    expect(host.querySelector('button[aria-label="Manage Basement"]')).toBeNull();
    expect(host.textContent).toContain("Shared with you");
  });

  it("opens a focused invitation dialog identifying the selected server", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => root?.render(<DashboardClient memberships={memberships} />));

    await act(async () => { await Promise.resolve(); });
    const manageButton = host.querySelector<HTMLButtonElement>('button[aria-label="Manage Living Room"]');
    expect(manageButton).toBeTruthy();
    await act(async () => manageButton!.click());
    const inviteItem = Array.from(document.body.querySelectorAll<HTMLElement>('[role="menuitem"]'))
      .find((item) => item.textContent === "Invite members");
    expect(inviteItem).toBeDefined();
    await act(async () => inviteItem!.click());

    // MUI Dialog portals to document.body
    const dialog = document.body.querySelector('[role="dialog"]');
    expect(dialog).toBeDefined();
    expect(dialog!.textContent).toContain("Living Room");
  });
});
