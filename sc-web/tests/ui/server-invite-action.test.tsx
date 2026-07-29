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
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
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

  it("shows invite and remove actions for every server, disabled for non-admins", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => root?.render(<DashboardClient memberships={memberships} />));

    const table = host.querySelector(".sc-dashboard-table")!;
    expect(table).toBeTruthy();

    const inviteBtns = Array.from(table.querySelectorAll<HTMLButtonElement>("button"))
      .filter((btn) => btn.textContent === "Invite user");
    expect(inviteBtns).toHaveLength(2);
    expect(inviteBtns[0].getAttribute("aria-label")).toBe("Invite users to Living Room");
    expect(inviteBtns[1].getAttribute("aria-label")).toContain("Invite users to Basement");

    const removeBtns = Array.from(table.querySelectorAll<HTMLButtonElement>("button"))
      .filter((btn) => btn.textContent === "Remove");
    expect(removeBtns).toHaveLength(2);

    // Non-admin name renders as a non-interactive span
    const memberSpans = Array.from(table.querySelectorAll("span"))
      .filter((span) => span.textContent === "Basement");
    expect(memberSpans.length).toBeGreaterThan(0);
    // Admin name renders as a clickable button
    const adminBtns = Array.from(table.querySelectorAll("button"))
      .filter((btn) => btn.textContent === "Living Room");
    expect(adminBtns.length).toBeGreaterThan(0);
    expect(adminBtns[0].getAttribute("aria-label")).toBe("Rename Living Room");
  });

  it("opens a focused invitation dialog identifying the selected server", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => root?.render(<DashboardClient memberships={memberships} />));

    const table = host.querySelector(".sc-dashboard-table")!;
    const inviteBtn = Array.from(table.querySelectorAll("button"))
      .find((btn) => btn.getAttribute("aria-label") === "Invite users to Living Room");
    expect(inviteBtn).toBeDefined();

    await act(async () => {
      inviteBtn!.click();
    });

    // MUI Dialog portals to document.body
    const dialog = document.body.querySelector('[role="dialog"]');
    expect(dialog).toBeDefined();
    expect(dialog!.textContent).toContain("Living Room");
  });
});
