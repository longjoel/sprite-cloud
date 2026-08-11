// @vitest-environment jsdom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  headers: vi.fn(),
  verifyBearerToken: vi.fn(),
  pathname: "/help",
}));

vi.mock("@/lib/auth", () => ({ auth: mocks.auth }));
vi.mock("next/headers", () => ({ headers: mocks.headers }));
vi.mock("@/lib/server-auth", () => ({ verifyBearerToken: mocks.verifyBearerToken }));
vi.mock("next/navigation", () => ({ usePathname: () => mocks.pathname }));
vi.mock("next/link", () => ({
  default: ({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a href={String(href)} {...props}>{children}</a>
  ),
}));

import Help from "@/app/help/page";

describe("LAN help navigation", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.clearAllMocks();
    mocks.auth.mockResolvedValue(null);
    mocks.headers.mockResolvedValue({
      get: vi.fn((name: string) => {
        if (name === "x-sc-server-lan") return "1";
        if (name === "authorization") return "Bearer lan-server";
        return null;
      }),
    });
    mocks.verifyBearerToken.mockResolvedValue({ id: "server-1" });
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn().mockImplementation(() => ({
        matches: false,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it("keeps the LAN Library and Help destinations when rendering /help", async () => {
    const page = await Help();
    expect(page.props.isLanProxy).toBe(true);
    expect(mocks.verifyBearerToken).toHaveBeenCalledWith("Bearer lan-server");

    await act(async () => root.render(page));

    const header = container.querySelector("header");
    expect(header?.textContent).toContain("Library");
    expect(header?.textContent).toContain("Help");
    expect(header?.textContent).not.toContain("Home");
    expect(header?.textContent).not.toContain("Sign in");
    const rootLinks = [...(header?.querySelectorAll('a[href="/"]') ?? [])];
    expect(rootLinks.some((link) => link.textContent === "Library")).toBe(true);
  });
});
