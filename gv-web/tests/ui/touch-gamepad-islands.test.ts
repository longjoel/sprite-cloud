// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TouchGamepad } from "@/lib/touch-gamepad";
import { computeDefaults } from "@/lib/touch-gamepad/presets";

function createGamepad(layout: "horizontal" | "vertical" = "horizontal") {
  const shell = document.createElement("div");
  const video = document.createElement("video");
  shell.appendChild(video);
  document.body.appendChild(shell);

  Object.defineProperty(video, "getBoundingClientRect", {
    value: () => ({ left: 0, top: 0, width: 844, height: 390, right: 844, bottom: 390, x: 0, y: 0, toJSON() {} }),
  });
  Object.defineProperty(shell, "getBoundingClientRect", {
    value: () => ({ left: 0, top: 0, width: 844, height: 390, right: 844, bottom: 390, x: 0, y: 0, toJSON() {} }),
  });

  const gamepad = new (TouchGamepad as any)(video, { preset: "nes", layout });
  gamepad.show();
  const canvas = shell.querySelector("canvas")!;
  Object.defineProperty(canvas, "getBoundingClientRect", {
    value: () => ({ left: 0, top: 0, width: 844, height: 390, right: 844, bottom: 390, x: 0, y: 0, toJSON() {} }),
  });
  return { gamepad, shell };
}

function touch(identifier: number, clientX: number, clientY: number) {
  return { identifier, clientX, clientY } as Touch;
}

function dispatchTouch(target: Element, type: string, changed: Touch[], active: Touch[]) {
  const event = new Event(type, { bubbles: true, cancelable: true }) as TouchEvent;
  Object.defineProperties(event, {
    changedTouches: { value: changed }, touches: { value: active },
  });
  target.dispatchEvent(event);
}

function dispatchPointer(target: Element, type: string, x: number, y: number, pointerId = 7, pointerType = "touch") {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y });
  Object.defineProperties(event, {
    pointerId: { value: pointerId }, pointerType: { value: pointerType }, isPrimary: { value: pointerId === 1 }, button: { value: 0 },
  });
  target.dispatchEvent(event);
}

describe("mobile touch-control islands", () => {
  beforeEach(() => {
    vi.stubGlobal("requestAnimationFrame", vi.fn(() => 1));
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(new Proxy({}, {
      get: () => vi.fn(), set: () => true,
    }) as CanvasRenderingContext2D);
  });

  afterEach(() => {
    document.body.replaceChildren();
    localStorage.clear();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("keeps the full-shell canvas visual-only and exposes isolated interactive groups", () => {
    const { shell } = createGamepad();
    const canvas = shell.querySelector("canvas")!;
    const layer = shell.querySelector<HTMLElement>("[data-touch-islands]")!;
    const groups = Array.from(shell.querySelectorAll<HTMLElement>("[data-touch-island]"));

    expect(canvas.style.pointerEvents).toBe("none");
    expect(layer).not.toBeNull();
    expect(layer.style.pointerEvents).toBe("none");
    expect(groups.map((group) => group.dataset.touchIsland)).toEqual(["dpad", "face", "system", "utility"]);
    expect(groups.every((group) => group.style.pointerEvents === "none")).toBe(true);
    expect(Array.from(shell.querySelectorAll<HTMLElement>("[data-touch-target]"))
      .every((target) => target.style.pointerEvents === "auto")).toBe(true);
  });

  it("applies the same four-edge safe-area geometry to canvas and target layer", () => {
    const { shell } = createGamepad("vertical");
    const canvas = shell.querySelector<HTMLCanvasElement>("canvas")!;
    const layer = shell.querySelector<HTMLElement>("[data-touch-islands]")!;
    const targets = Array.from(shell.querySelectorAll<HTMLElement>("[data-touch-target]"));

    for (const edge of ["left", "right", "top", "bottom"] as const) {
      expect(canvas.style.getPropertyValue(edge) + canvas.style.width + canvas.style.height)
        .toContain(`safe-area-inset-${edge}`);
      expect(layer.style.getPropertyValue(edge)).toBe(canvas.style.getPropertyValue(edge));
    }
    expect(targets.length).toBeGreaterThanOrEqual(7);
    expect(targets.every((target) => Number.parseFloat(target.style.minWidth) >= 44)).toBe(true);
    expect(targets.every((target) => Number.parseFloat(target.style.minHeight) >= 44)).toBe(true);
    expect(targets.every((target) => target.style.width.endsWith("%"))).toBe(true);
    expect(targets.every((target) => target.style.height.endsWith("%"))).toBe(true);
    expect(targets.every((target) => target.style.borderWidth === "2px")).toBe(true);
    expect(targets.every((target) => !target.style.left.includes("touch-safe"))).toBe(true);
    expect(targets.every((target) => !target.style.top.includes("touch-safe"))).toBe(true);
  });

  it.each([[320, 320, "vertical"], [844, 390, "horizontal"]] as const)(
    "centers expanded targets without overlap at %ipx",
    (width, height, orientation) => {
      const { shell } = createGamepad(orientation);
      const targets = Array.from(shell.querySelectorAll<HTMLElement>("[data-touch-target]"));
      const rects = targets.map((target) => {
        const x = Number(target.dataset.normX); const y = Number(target.dataset.normY);
        const nw = Number(target.dataset.normW); const nh = Number(target.dataset.normH);
        const w = Math.max(44, nw * width); const h = Math.max(44, nh * height);
        return { label: target.dataset.touchTarget, left: x * width - (w - nw * width) / 2,
          top: y * height - (h - nh * height) / 2, width: w, height: h };
      });
      for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) {
        const a = rects[i], b = rects[j];
        const overlap = a.left < b.left + b.width && b.left < a.left + a.width
          && a.top < b.top + b.height && b.top < a.top + a.height;
        expect(overlap, `${a.label} overlaps ${b.label}`).toBe(false);
      }
    },
  );

  it("suspends island input for player panels and releases pressed state", () => {
    const { gamepad, shell } = createGamepad();
    const onInput = vi.fn();
    gamepad.onInput = onInput;
    const layer = shell.querySelector<HTMLElement>("[data-touch-islands]")!;

    gamepad.suspendInput();

    expect(layer.style.pointerEvents).toBe("none");
    expect(onInput).toHaveBeenLastCalledWith({
      dpad: [false, false, false, false],
      face: [false, false],
      system: [false, false],
    });

    gamepad.resumeInput();
    expect(layer.style.pointerEvents).toBe("none");
    expect(Array.from(layer.querySelectorAll<HTMLElement>("[data-touch-target]")).every(
      (target) => target.style.pointerEvents === "auto",
    )).toBe(true);
  });

  it("cannot reactivate an already-active pointer after press then suspend", () => {
    const { gamepad, shell } = createGamepad();
    const onInput = vi.fn(); gamepad.onInput = onInput;
    const face = shell.querySelector<HTMLElement>('[data-touch-target="face-0"]')!;
    dispatchPointer(face, "pointerdown", 700, 340, 1);
    expect(onInput.mock.calls.some(([state]) => state.face.some(Boolean))).toBe(true);
    gamepad.suspendInput();
    gamepad.resumeInput();
    const callsAfterSuspend = onInput.mock.calls.length;
    dispatchPointer(face, "pointermove", 700, 340, 1);
    expect(onInput.mock.calls.slice(callsAfterSuspend).every(([state]) => !state.face.some(Boolean))).toBe(true);
    dispatchPointer(face, "pointerup", 700, 340, 1);
    expect(onInput).toHaveBeenLastCalledWith({ dpad: [false, false, false, false], face: [false, false], system: [false, false] });
    expect(gamepad._dragTarget).toBeNull();
    expect(gamepad._dragStart).toBeNull();
  });

  it("blank layer space emits nothing while simultaneous pointer IDs aggregate dpad and face", () => {
    const { gamepad, shell } = createGamepad();
    const onInput = vi.fn(); gamepad.onInput = onInput;
    const layer = shell.querySelector<HTMLElement>("[data-touch-islands]")!;
    const dpad = shell.querySelector<HTMLElement>('[data-touch-target="dpad"]')!;
    const face = shell.querySelector<HTMLElement>('[data-touch-target="face-0"]')!;
    dispatchPointer(layer, "pointerdown", 400, 100, 99);
    expect(onInput).not.toHaveBeenCalled();
    dispatchPointer(dpad, "pointerdown", 150, 300, 1);
    dispatchPointer(face, "pointerdown", 700, 340, 2);
    expect(onInput).toHaveBeenLastCalledWith(expect.objectContaining({
      dpad: expect.arrayContaining([expect.any(Boolean)]),
      face: expect.arrayContaining([true]),
    }));
    expect(onInput.mock.lastCall![0].dpad.some(Boolean)).toBe(true);
    dispatchPointer(dpad, "pointerup", 150, 300, 1);
    expect(onInput.mock.lastCall![0].face.some(Boolean)).toBe(true);
    dispatchPointer(face, "pointerup", 700, 340, 2);
    expect(onInput).toHaveBeenLastCalledWith({ dpad: [false, false, false, false], face: [false, false], system: [false, false] });
  });

  it("captures and releases each pointer on its actual target", () => {
    const { shell } = createGamepad();
    const face = shell.querySelector<HTMLElement>('[data-touch-target="face-0"]')!;
    face.setPointerCapture = vi.fn();
    face.releasePointerCapture = vi.fn();
    dispatchPointer(face, "pointerdown", 700, 340, 12, "pen");
    expect(face.setPointerCapture).toHaveBeenCalledWith(12);
    dispatchPointer(face, "pointerup", 700, 340, 12, "pen");
    expect(face.releasePointerCapture).toHaveBeenCalledWith(12);
  });

  it("suspend mid-pointer disables actual targets and blocks later move and up", () => {
    const { gamepad, shell } = createGamepad();
    const onInput = vi.fn(); gamepad.onInput = onInput;
    const face = shell.querySelector<HTMLElement>('[data-touch-target="face-0"]')!;
    dispatchPointer(face, "pointerdown", 700, 340, 21);
    gamepad.suspendInput();
    const calls = onInput.mock.calls.length;
    expect(face.style.pointerEvents).toBe("none");
    dispatchPointer(face, "pointermove", 150, 300, 21);
    dispatchPointer(face, "pointerup", 150, 300, 21);
    expect(onInput).toHaveBeenCalledTimes(calls);
  });

  it("allows a fresh pointerdown to reuse an ID after suspend and resume", () => {
    const { gamepad, shell } = createGamepad();
    const onInput = vi.fn(); gamepad.onInput = onInput;
    const face = shell.querySelector<HTMLElement>('[data-touch-target="face-0"]')!;
    dispatchPointer(face, "pointerdown", 700, 340, 1, "mouse");
    gamepad.suspendInput(); gamepad.resumeInput();
    dispatchPointer(face, "pointerdown", 700, 340, 1, "mouse");
    expect(onInput).toHaveBeenLastCalledWith(expect.objectContaining({ face: [true, false] }));
  });

  it.each(["hide", "orientation"])("releases pointer capture before clearing on %s", (action) => {
    vi.useFakeTimers();
    const { gamepad, shell } = createGamepad();
    const face = shell.querySelector<HTMLElement>('[data-touch-target="face-0"]')!;
    face.releasePointerCapture = vi.fn();
    dispatchPointer(face, "pointerdown", 700, 340, 17);
    if (action === "hide") gamepad.hide();
    else gamepad._onOrientationChange();
    expect(face.releasePointerCapture).toHaveBeenCalledWith(17);
    vi.useRealTimers();
  });

  it("shares canvas geometry and syncs programmatic and dragged layouts", () => {
    const { gamepad, shell } = createGamepad();
    const canvas = shell.querySelector<HTMLCanvasElement>("canvas")!;
    const layer = shell.querySelector<HTMLElement>("[data-touch-islands]")!;
    expect(layer.style.paddingLeft).toBe("");
    expect(layer.style.paddingBottom).toBe("");
    expect(layer.style.left).toBe(canvas.style.left);
    expect(layer.style.width).toBe(canvas.style.width);
    gamepad.setPreset("snes");
    expect(layer.querySelectorAll('[data-touch-target^="face-"]')).toHaveLength(4);
    gamepad.enterEditMode();
    const dpad = layer.querySelector<HTMLElement>('[data-touch-target="dpad"]')!;
    const dpadGroup = dpad.parentElement!;
    const appendSpy = vi.spyOn(dpadGroup, "appendChild");
    const before = dpad.style.left;
    dispatchPointer(dpad, "pointerdown", 150, 300, 4);
    dispatchPointer(dpad, "pointermove", 220, 300, 4);
    const movedDpad = layer.querySelector<HTMLElement>('[data-touch-target="dpad"]')!;
    expect(movedDpad).toBe(dpad);
    expect(movedDpad.isConnected).toBe(true);
    expect(appendSpy).not.toHaveBeenCalled();
    dispatchPointer(dpad, "pointerup", 220, 300, 4);
    expect(movedDpad.style.left).not.toBe(before);
  });

  it("clears drag and active input on cancellation, hide, destruction, and orientation", () => {
    vi.useFakeTimers();
    const { gamepad, shell } = createGamepad();
    const layer = shell.querySelector<HTMLElement>("[data-touch-islands]")!;
    const face = layer.querySelector<HTMLElement>('[data-touch-target="face-0"]')!;
    dispatchPointer(face, "pointerdown", 700, 340, 8);
    dispatchPointer(face, "pointercancel", 700, 340, 8);
    expect(gamepad._faceStates.every((value: boolean) => !value)).toBe(true);
    gamepad.enterEditMode();
    const dpad = layer.querySelector<HTMLElement>('[data-touch-target="dpad"]')!;
    dispatchPointer(dpad, "pointerdown", 150, 300, 9);
    gamepad.hide();
    expect(gamepad._dragStart).toBeNull();
    gamepad.show();
    window.dispatchEvent(new Event("orientationchange"));
    expect(gamepad._dragStart).toBeNull();
    gamepad.destroy();
    expect(shell.querySelector("canvas")).toBeNull();
    expect(shell.querySelector("[data-touch-islands]")).toBeNull();
    vi.useRealTimers();
  });

  it("places controls as left, right, and compact center islands in both orientations", () => {
    for (const orientation of ["horizontal", "vertical"]) {
      const layout = computeDefaults("nes", orientation);
      const faceLeft = Math.min(...layout.face.map((button) => button.x));
      const systemCenter = layout.system.reduce((sum, button) => sum + button.x + button.w / 2, 0) / layout.system.length;

      expect(layout.dpad.x + layout.dpad.w).toBeLessThan(0.4);
      expect(faceLeft).toBeGreaterThan(0.6);
      expect(systemCenter).toBeGreaterThan(0.35);
      expect(systemCenter).toBeLessThan(0.65);
    }
  });

  it("uses Sprite Cloud sharp 2px control styling", () => {
    const source = readFileSync("lib/touch-gamepad/index.ts", "utf8");

    expect(source).toContain("ctx.roundRect(x, y, w, h, 2)");
    expect(source).toContain("ctx.lineWidth = 2");
  });

  it("marks the visual layer as static when reduced motion is requested", () => {
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: true }));
    const { shell } = createGamepad();

    expect(shell.querySelector("canvas")?.dataset.reducedMotion).toBe("true");
  });

  it("renders exactly once for each reduced-motion locked pointer state change", () => {
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: true }));
    const callbacks: FrameRequestCallback[] = [];
    const raf = vi.fn((callback: FrameRequestCallback) => { callbacks.push(callback); return callbacks.length; });
    vi.stubGlobal("requestAnimationFrame", raf);
    const { shell } = createGamepad();
    callbacks.shift()!(0);
    expect(raf).toHaveBeenCalledTimes(1);
    const face = shell.querySelector<HTMLElement>('[data-touch-target="face-0"]')!;
    for (const [type, x] of [["pointerdown", 700], ["pointermove", 710], ["pointerup", 710]] as const) {
      dispatchPointer(face, type, x, 340, 31);
      expect(callbacks).toHaveLength(1);
      callbacks.shift()!(0);
    }
    expect(raf).toHaveBeenCalledTimes(4);
    expect(callbacks).toHaveLength(0);
  });
});
