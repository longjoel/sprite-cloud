// @vitest-environment jsdom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import XmbSettings, { hasXmbSettingsAccess, type XmbServer } from "@/components/xmb/XmbSettings";

const adminServer = (overrides: Partial<XmbServer> = {}): XmbServer => ({
  id: "server-admin",
  name: "Bazzite",
  gameCount: 24,
  lastSeenAt: new Date().toISOString(),
  role: "admin",
  ...overrides,
});

async function renderSettings(servers: XmbServer[]) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => root.render(<XmbSettings servers={servers} />));
  return { host, root };
}

describe("XMB settings access", () => {
  it("omits Settings for guests and viewer-only memberships", () => {
    expect(hasXmbSettingsAccess(false, [])).toBe(false);
    expect(hasXmbSettingsAccess(true, [adminServer({ role: "member" })])).toBe(false);
    expect(hasXmbSettingsAccess(true, [adminServer({ role: "viewer" })])).toBe(false);
  });

  it("allows admins and signed-in users with no server to pair", () => {
    expect(hasXmbSettingsAccess(true, [adminServer()])).toBe(true);
    expect(hasXmbSettingsAccess(true, [])).toBe(true);
  });
});

describe("XmbSettings", () => {
  let roots: Root[] = [];

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    document.cookie = "gv_csrf_token=xmb-test; Path=/";
  });

  afterEach(async () => {
    for (const root of roots) await act(async () => root.unmount());
    roots = [];
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  it("shows paired servers, online state, pairing, and the full admin dashboard link", async () => {
    const { host, root } = await renderSettings([
      adminServer(),
      adminServer({ id: "server-offline", name: "Basement", lastSeenAt: null, role: "member", gameCount: 3 }),
    ]);
    roots.push(root);

    expect(host.querySelector("iframe")).toBeNull();
    expect(host.textContent).toContain("Paired servers");
    expect(host.textContent).toContain("Bazzite");
    expect(host.textContent).toContain("24 games");
    expect(host.textContent).toContain("online");
    expect(host.textContent).toContain("Basement");
    expect(host.textContent).toContain("offline");

    const pair = Array.from(host.querySelectorAll("button")).find((button) => button.textContent === "Generate pairing code");
    expect(pair?.getAttribute("aria-label")).toBe("Generate server pairing code");
    expect(pair?.getAttribute("type")).toBe("button");

    const dashboard = host.querySelector<HTMLAnchorElement>('a[href="/dashboard"]');
    expect(dashboard?.textContent).toContain("Full admin dashboard");
    expect(dashboard?.getAttribute("aria-label")).toBe("Open full admin dashboard");
    expect(host.querySelectorAll("[data-xmb-settings-action]")).toHaveLength(2);
  });

  it("exposes exactly the pair action when there is no server", async () => {
    const { host, root } = await renderSettings([]);
    roots.push(root);

    const actions = host.querySelectorAll<HTMLElement>("[data-xmb-settings-action]");
    expect(actions).toHaveLength(1);
    expect(actions[0].textContent).toBe("Generate pairing code");
  });

  it("uses the supported authenticated pairing endpoint and renders its command", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({ code: "ABCD1234" }),
    } as Response);
    const { host, root } = await renderSettings([adminServer()]);
    roots.push(root);
    const pair = Array.from(host.querySelectorAll("button")).find((button) => button.textContent === "Generate pairing code")!;

    await act(async () => pair.dispatchEvent(new MouseEvent("click", { bubbles: true })));

    expect(fetchMock).toHaveBeenCalledWith("/api/auth/pair/generate", expect.objectContaining({
      method: "POST",
      headers: expect.objectContaining({ "x-csrf-token": "xmb-test" }),
    }));
    expect(host.textContent).toContain("ABCD1234");
    expect(host.textContent).toContain("gv-server pair ABCD1234 --gv-web-url");
    expect(host.querySelector('[role="status"]')).not.toBeNull();
  });

  it("has compact Metro touch targets and safe-area responsive layouts", () => {
    const css = readFileSync(resolve(process.cwd(), "components/xmb/XmbSettings.module.css"), "utf8");
    expect(css).toContain("font-family: var(--font-mono)");
    expect(css).toMatch(/border-radius:\s*2px/);
    expect(css).toMatch(/min-height:\s*44px/);
    expect(css).toContain("env(safe-area-inset-left)");
    expect(css).toContain("env(safe-area-inset-right)");
    expect(css).toContain("env(safe-area-inset-bottom)");
    expect(css).toMatch(/padding:\s*max\([^;]*safe-area-inset-top/);
    expect(css).toMatch(/@media\s*\(orientation:\s*portrait\)/);
    expect(css).toMatch(/@media\s*\(orientation:\s*landscape\)\s*and\s*\(max-height:\s*500px\)/);
    expect(css).toMatch(/overflow-y:\s*auto/);
  });
});

describe("XMB shell structure", () => {
  it("contains no iframe and treats Classic as a direct navigation action", () => {
    const source = readFileSync(resolve(process.cwd(), "app/xmb/page.tsx"), "utf8");
    expect(source).not.toMatch(/<iframe|settingsFrame|src=["']\/dashboard["']/);
    expect(source).toContain("<XmbSettings");
    expect(source).toContain("href={item.href}");
    expect(source).not.toMatch(/id:\s*["']classic["']/);
  });

  it("keeps the bottom bar above the safe area and reserves matching body clearance", () => {
    const source = readFileSync(resolve(process.cwd(), "app/xmb/page.tsx"), "utf8");
    expect(source).toMatch(/paddingBottom:\s*"env\(safe-area-inset-bottom\)"/);
    expect(source).toMatch(/bottom:\s*"calc\(72px \+ env\(safe-area-inset-bottom\)\)"/);
  });
});

describe("XMB player launch lifecycle (Task 13)", () => {
  it("imports the shared launch utility instead of mounting an inline GamePlayer", () => {
    const source = readFileSync(resolve(process.cwd(), "app/xmb/page.tsx"), "utf8");
    // Must use shared utility
    expect(source).toContain("@/lib/ui/launch-game");
    // Must NOT have inline <GamePlayer /> in JSX
    expect(source).not.toMatch(/<GamePlayer/);
  });

  it("removes the XMB-specific back-hint bar", () => {
    const source = readFileSync(resolve(process.cwd(), "app/xmb/page.tsx"), "utf8");
    expect(source).not.toContain("backHint");
    expect(source).not.toMatch(/Press Esc or ○ to close/);
  });

  it("navigates to /p/[code]?shell=xmb on game launch", () => {
    const source = readFileSync(resolve(process.cwd(), "app/xmb/page.tsx"), "utf8");
    // Must use buildPlayerPath with "xmb" shell param and router.push to navigate
    expect(source).toContain('buildPlayerPath(code, "xmb")');
    expect(source).toMatch(/router\.(push|replace)\(/);
    expect(source).toContain("createLaunchShortCode");
  });

  it("preserves XMB navigation, gamepad, and responsive layout code", () => {
    const source = readFileSync(resolve(process.cwd(), "app/xmb/page.tsx"), "utf8");
    // Navigation
    expect(source).toContain("activateXmbNavigation");
    expect(source).toContain("moveXmbNavigation");
    // Gamepad
    expect(source).toContain("getGamepads");
    // Keyboard handlers (not play-mode Escape/port keys)
    expect(source).toContain("ArrowLeft");
    expect(source).toContain("ArrowRight");
    // Responsive / mobile
    expect(source).toContain("isMobile");
    expect(source).toContain("ontouchstart");
    // Search
    expect(source).toContain("Search");
  });

  it("removes inline playing state, closePlayer, and play-mode Escape listener", () => {
    const source = readFileSync(resolve(process.cwd(), "app/xmb/page.tsx"), "utf8");
    // Playing-related states that should be gone
    expect(source).not.toContain("setPlaying");
    expect(source).not.toContain("setPlayGame");
    expect(source).not.toContain("fadeIn");
    expect(source).not.toContain("fadingOut");
    expect(source).not.toContain("closePlayer");
    expect(source).not.toContain("handlePlayerTransitionEnd");
    // Play-mode Escape listener
    expect(source).not.toMatch(/playing.*Escape/);
    // Port routing hotkeys (Ctrl+1-4, Ctrl+0)
    expect(source).not.toContain("kbdPort");
    expect(source).not.toContain("kbd_port");
  });
});
