// @vitest-environment jsdom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ThemeProvider, createTheme } from "@mui/material/styles";

const sessionState = vi.hoisted(() => ({ data: null as null | { user: { name: string; email: string } } }));

vi.mock("next/navigation", () => ({
  usePathname: () => "/p/ABC123",
}));

vi.mock("next-auth/react", () => ({
  useSession: () => sessionState,
}));

vi.mock("next/link", () => ({
  default: ({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a href={typeof href === "string" ? href : "/"} {...props}>{children}</a>
  ),
}));

import PlayerWorkspace from "@/components/player/PlayerWorkspace";

const gamePlayerSource = readFileSync("components/GamePlayer.tsx", "utf8");
const playerShellSource = readFileSync("components/PlayerShell.tsx", "utf8");
const appHeaderSource = readFileSync("components/fluent/AppHeader.tsx", "utf8");
const playerWorkspaceSource = readFileSync("components/player/PlayerWorkspace.tsx", "utf8");
const gameStageSource = readFileSync("components/player/GameStage.tsx", "utf8");
const brandReadme = readFileSync("public/brand/README.md", "utf8");
const brandAsset = readFileSync("public/brand/sprite-cloud-logo-banner.jpg");

describe("Material UI player room workspace", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    sessionState.data = null;
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  it("renders branded Room view around a bounded game stage", async () => {
    await act(async () => {
      root.render(
        <ThemeProvider theme={createTheme({ palette: { mode: "dark" } })}>
          <PlayerWorkspace
            gameName="Metal Slug"
            platform="Arcade"
            isFullscreen={false}
            isLanProxy={false}
            stageRef={{ current: null }}
          >
            <div data-testid="game-stream">stream</div>
          </PlayerWorkspace>
        </ThemeProvider>,
      );
    });

    expect(host.querySelector('img[alt="Sprite Cloud"]')).not.toBeNull();
    expect(host.querySelector('[data-player-workspace="room"]')).not.toBeNull();
    expect(host.querySelector('[data-game-stage]')).not.toBeNull();
    expect(host.textContent).toContain("Metal Slug");
    expect(host.textContent).toContain("Arcade");
    expect(host.textContent).toContain("Room");
    expect(Array.from(host.querySelectorAll("button")).some((button) => button.textContent?.includes("Fullscreen"))).toBe(false);
    expect(playerWorkspaceSource).not.toContain("onFullscreen={onFullscreen}");
  });

  it("preserves authenticated navigation in Room view", async () => {
    sessionState.data = { user: { name: "Joel", email: "joel@sprite-cloud.com" } };
    await act(async () => {
      root.render(
        <ThemeProvider theme={createTheme({ palette: { mode: "dark" } })}>
          <PlayerWorkspace
            gameName="Metal Slug"
            isFullscreen={false}
            isLanProxy={false}
            stageRef={{ current: null }}
          >
            <div>stream</div>
          </PlayerWorkspace>
        </ThemeProvider>,
      );
    });

    expect(host.textContent).toContain("Joel");
    expect(host.textContent).toContain("Sign out");
    expect(host.textContent).not.toContain("Sign in");
  });

  it("keeps LAN Room navigation server-owned even when a cloud session exists", async () => {
    sessionState.data = { user: { name: "Joel", email: "joel@sprite-cloud.com" } };
    await act(async () => {
      root.render(
        <ThemeProvider theme={createTheme({ palette: { mode: "dark" } })}>
          <PlayerWorkspace
            gameName="Metal Slug"
            isFullscreen={false}
            isLanProxy
            stageRef={{ current: null }}
          >
            <div>stream</div>
          </PlayerWorkspace>
        </ThemeProvider>,
      );
    });

    expect(host.textContent).toContain("Library");
    expect(host.textContent).toContain("Help");
    expect(host.textContent).not.toContain("Sign in");
    expect(host.textContent).not.toContain("Sign out");
    expect(host.textContent).not.toContain("Home");
  });

  it("scopes fullscreen to GameStage instead of the document", () => {
    expect(gamePlayerSource).toContain("stageRef.current?.requestFullscreen()");
    expect(gamePlayerSource).not.toContain("document.documentElement.requestFullscreen()");
    expect(gameStageSource).toContain("data-game-stage");
    expect(gameStageSource).toContain('aspectRatio: "4 / 3"');
  });

  it("routes every shared player shell through the workspace", () => {
    expect(playerShellSource).toContain("<GamePlayer");
    expect(gamePlayerSource).toContain("<PlayerWorkspace");
    expect(playerWorkspaceSource).toContain("<GameStage");
  });
});

describe("Sprite Cloud brand source", () => {
  it("preserves the draft PR #724 source bytes and metadata", () => {
    expect(createHash("sha256").update(brandAsset).digest("hex"))
      .toBe("9da82e9d2935ddc220d63eb94f04640f423891e30127b1bd8f09d5ccc7d0853d");
    expect(brandReadme).toContain("draft PR #724");
    expect(brandReadme).toContain("1280 × 426");
  });

  it("uses the brand asset in shared application navigation", () => {
    expect(appHeaderSource).toContain('/brand/sprite-cloud-logo-banner.jpg');
    expect(appHeaderSource).toContain('alt="Sprite Cloud"');
  });
});
