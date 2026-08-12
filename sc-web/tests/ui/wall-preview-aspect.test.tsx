// @vitest-environment jsdom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WallPreview from "@/components/WallPreview";

describe("live gameplay video aspect ratio", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  it("always contains the full emulator frame instead of cropping it", async () => {
    await act(async () => {
      root.render(
        <WallPreview
          roomToken="room-token"
          gameId="game-id"
          serverId="server-id"
          active={false}
        />,
      );
    });

    const video = host.querySelector<HTMLVideoElement>("video");
    expect(video?.style.width).toBe("100%");
    expect(video?.style.height).toBe("100%");
    expect(video?.style.objectFit).toBe("contain");
  });
});
