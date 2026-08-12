// @vitest-environment jsdom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ThemeProvider, createTheme } from "@mui/material/styles";

const previewProps = vi.hoisted(() => ({ current: null as null | Record<string, unknown> }));

vi.mock("next/navigation", () => ({
  usePathname: () => "/watch/metal-slug",
}));

vi.mock("next-auth/react", () => ({
  useSession: () => ({ data: null }),
}));

vi.mock("next/link", () => ({
  default: ({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a href={typeof href === "string" ? href : "/"} {...props}>{children}</a>
  ),
}));

vi.mock("@/components/WallPreview", () => ({
  default: (props: Record<string, unknown>) => {
    previewProps.current = props;
    return <video data-testid="watch-video" />;
  },
}));

import WatchPlayer from "@/components/WatchPlayer";

describe("large public watch page layout", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    previewProps.current = null;
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

  it("keeps navigation, contained video, and Play inside one viewport", async () => {
    await act(async () => {
      root.render(
        <ThemeProvider theme={createTheme({ palette: { mode: "dark" } })}>
          <WatchPlayer
            roomToken="room-token"
            gameId="game-id"
            serverId="server-id"
            gameName="Metal Slug"
            platform="Arcade"
            players={1}
            viewers={2}
            roomUrl="/r/room-token"
          />
        </ThemeProvider>,
      );
    });

    const page = host.querySelector<HTMLElement>("[data-watch-page]");
    const videoRegion = host.querySelector<HTMLElement>("[data-watch-video-region]");
    const play = host.querySelector<HTMLAnchorElement>('a[href="/r/room-token"]');

    expect(host.querySelector('img[alt="Sprite Cloud"]')).not.toBeNull();
    expect(page?.style.height).toBe("100dvh");
    expect(page?.style.overflow).toBe("hidden");
    expect(videoRegion?.style.minHeight).toBe("0px");
    expect(play?.textContent).toContain("Play");
    expect(previewProps.current).toMatchObject({ active: true });
  });
});
