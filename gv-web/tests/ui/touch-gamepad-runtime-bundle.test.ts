// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

describe("generated touch gamepad runtime bundle", () => {
  afterEach(() => {
    delete (window as any).TouchGamepad;
    delete (window as any).__gvTouchGamepad;
    document.body.replaceChildren();
    localStorage.clear();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("exposes every API used by the Controller Layout panel", () => {
    vi.stubGlobal("requestAnimationFrame", vi.fn());
    const bundle = readFileSync(
      resolve(process.cwd(), "public/player/touch-gamepad-v2.js"),
      "utf8",
    );

    window.eval(bundle);

    const prototype = (window as any).TouchGamepad?.prototype;
    expect(prototype).toBeDefined();
    for (const api of ["getOpacity", "setOpacity", "getSizePreset", "setSizePreset", "resetLayout", "exitEditMode"]) {
      expect(typeof prototype[api], `${api} must exist in the browser runtime`).toBe("function");
    }
  });

  it("ships full-shell portrait geometry and one-time v2 layout migration", () => {
    vi.stubGlobal("requestAnimationFrame", vi.fn(() => 1));
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(new Proxy({}, {
      get: () => vi.fn(), set: () => true,
    }) as CanvasRenderingContext2D);
    localStorage.setItem("gv:touch-layouts-v2", JSON.stringify({
      "nes:vertical": {
        dpad: { x: 0.1, y: 0.2, w: 0.3, h: 0.4 },
        face: [
          { x: 0.6, y: 0.2, w: 0.1, h: 0.2, label: "B" },
          { x: 0.8, y: 0.3, w: 0.1, h: 0.2, label: "A" },
        ],
        system: [
          { x: 0.4, y: 0.8, w: 0.1, h: 0.12, label: "SELECT" },
          { x: 0.52, y: 0.8, w: 0.1, h: 0.12, label: "START" },
        ],
      },
    }));
    const shell = document.createElement("div");
    const video = document.createElement("video");
    shell.appendChild(video);
    document.body.appendChild(shell);

    window.eval(readFileSync(resolve(process.cwd(), "public/player/touch-gamepad-v2.js"), "utf8"));
    const gamepad = new (window as any).TouchGamepad(video, { preset: "nes", layout: "vertical" });
    gamepad.show();

    const canvas = shell.querySelector<HTMLCanvasElement>("canvas")!;
    const layer = shell.querySelector<HTMLElement>("[data-touch-islands]")!;
    expect(canvas.style.height).toContain("100vh");
    expect(canvas.style.height).not.toContain("50vh");
    expect(canvas.style.pointerEvents).toBe("none");
    expect(layer.style.pointerEvents).toBe("none");
    expect(gamepad._dpad).toEqual({ x: 0.1, y: 0.6, w: 0.3, h: 0.2 });
    expect(JSON.parse(localStorage.getItem("gv:touch-layouts-v3")!)["nes:vertical"].dpad)
      .toEqual(gamepad._dpad);
  });
});
