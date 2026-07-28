// @vitest-environment jsdom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import DashboardClient from "@/app/servers/DashboardClient";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

const memberships = [
  { id: "server-admin", name: "Living Room", lastSeenAt: null, role: "admin" },
  { id: "server-member", name: "Basement", lastSeenAt: null, role: "member" },
];

describe("server invitation action", () => {
  let root: Root | null = null;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      const body = url.endsWith("/invites")
        ? init?.method === "POST"
          ? { invite: { url: "/invite/test-capability" } }
          : { invites: [] }
        : { metadata: null };
      return { ok: true, json: async () => body } as Response;
    });
  });

  afterEach(async () => {
    if (root) await act(async () => root?.unmount());
    root = null;
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  it("shows a primary invite action for every server and disables it for non-admins", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => root?.render(<DashboardClient memberships={memberships} />));

    const actions = Array.from(host.querySelectorAll<HTMLButtonElement>("button"))
      .filter((button) => button.textContent === "Invite user");

    expect(actions).toHaveLength(2);
    expect(actions[0].disabled).toBe(false);
    expect(actions[0].getAttribute("aria-label")).toBe("Invite users to Living Room");
    expect(actions[1].disabled).toBe(true);
    expect(actions[1].title).toContain("Only server administrators");

    const removeButtons = Array.from(host.querySelectorAll<HTMLButtonElement>("button")).filter(
      (button) => button.textContent === "Remove",
    );
    expect(removeButtons).toHaveLength(2);
    expect(removeButtons[0].disabled).toBe(false);
    expect(removeButtons[1].disabled).toBe(true);

    const memberName = Array.from(host.querySelectorAll<HTMLSpanElement>("span")).find(
      (span) => span.textContent === "Basement",
    );
    await act(async () => {
      memberName?.click();
    });
    expect(host.querySelector("input")).toBeNull();
  });

  it("opens a focused invitation dialog identifying the selected server", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => root?.render(<DashboardClient memberships={memberships} />));

    const action = Array.from(host.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.getAttribute("aria-label") === "Invite users to Living Room");
    expect(action).toBeDefined();

    await act(async () => action?.dispatchEvent(new MouseEvent("click", { bubbles: true })));

    const dialog = document.body.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog?.textContent).toContain("Invite users to Living Room");
    expect(dialog?.textContent).toContain("Create invitation");
    expect(dialog?.textContent).toContain("Invitation history");
  });

  it("creates an invitation from the dialog and exposes the one-time copy action", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => root?.render(<DashboardClient memberships={memberships} />));

    const inviteAction = Array.from(host.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.getAttribute("aria-label") === "Invite users to Living Room")!;
    await act(async () => inviteAction.dispatchEvent(new MouseEvent("click", { bubbles: true })));

    const dialog = document.body.querySelector('[role="dialog"]')!;
    const create = Array.from(dialog.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent === "Create invitation")!;
    await act(async () => create.dispatchEvent(new MouseEvent("click", { bubbles: true })));

    expect(dialog.textContent).toContain("http://localhost:3000/invite/test-capability");
    expect(dialog.textContent).toContain("The secret is not stored and cannot be shown again.");

    const copy = Array.from(dialog.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent === "Copy link")!;
    await act(async () => copy.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(writeText).toHaveBeenCalledWith("http://localhost:3000/invite/test-capability");
  });
});
