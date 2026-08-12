// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useMotionSafeCoverUrl } from "@/components/useMotionSafeCoverUrl";
import { coverPosterUrl } from "@/components/useMotionSafeCoverUrl";

let root: Root | undefined;
afterEach(() => { if (root) act(() => root!.unmount()); document.body.innerHTML = ""; vi.unstubAllGlobals(); root = undefined; });

function Probe({ url }: { url: string }) {
  return createElement("output", null, useMotionSafeCoverUrl(url));
}

function render(url: string) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(createElement(Probe, { url })));
  return container;
}

describe("motion-safe cover URLs", () => {
  it("does not rewrite local upload or RetroArch preview URLs", () => {
    expect(coverPosterUrl("blob:http://localhost/upload")).toBe("blob:http://localhost/upload");
    expect(coverPosterUrl("/api/servers/s/games/g/cover/candidates/preview?id=signed")).toBe("/api/servers/s/games/g/cover/candidates/preview?id=signed");
    expect(coverPosterUrl("/foo/api/covers/server/game")).toBe("/foo/api/covers/server/game");
  });

  it("sets an exact poster query while preserving queries and fragments", () => {
    expect(coverPosterUrl("/api/covers/server/game?notposter=1#preview")).toBe("/api/covers/server/game?notposter=1&poster=1#preview");
    expect(coverPosterUrl("/api/covers/server/game?poster=10")).toBe("/api/covers/server/game?poster=1");
    expect(coverPosterUrl("/api/covers/server/game#preview")).toBe("/api/covers/server/game?poster=1#preview");
  });
  it("fails static and remains on the poster for reduced-motion users", async () => {
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
    const container = render("/api/covers/server/game?v=1");
    expect(container.textContent).toBe("/api/covers/server/game?v=1&poster=1");
    await act(async () => { await Promise.resolve(); });
    expect(container.textContent).toBe("/api/covers/server/game?v=1&poster=1");
  });

  it("enables animation only after the browser confirms motion is allowed", async () => {
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
    const container = render("/api/covers/server/game");
    await act(async () => { await Promise.resolve(); });
    expect(container.textContent).toBe("/api/covers/server/game");
  });
});
