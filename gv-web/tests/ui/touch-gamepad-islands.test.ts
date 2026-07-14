// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TouchGamepad } from "@/lib/touch-gamepad";
import { computeDefaults } from "@/lib/touch-gamepad/presets";

const layoutKeyV2 = "gv:touch-layouts-v2";
const layoutKeyV3 = "gv:touch-layouts-v3";
const sizePresetKey = "gv:touch-size-preset";

function createGamepad(
  layout: "horizontal" | "vertical" = "horizontal",
  preset: "nes" | "snes" = "nes",
) {
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

  const gamepad = new (TouchGamepad as any)(video, { preset, layout });
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
    expect(groups.map((group) => group.dataset.touchIsland)).toEqual(["dpad", "face", "system"]);
    expect(groups.every((group) => group.style.pointerEvents === "none")).toBe(true);
    expect(Array.from(shell.querySelectorAll<HTMLElement>("[data-touch-target]"))
      .every((target) => target.style.pointerEvents === "auto")).toBe(true);
  });

  it("keeps layout utility controls out of the gameplay canvas", () => {
    const { shell } = createGamepad();

    expect(shell.querySelector('[data-touch-island="utility"]')).toBeNull();
    expect(shell.querySelector('[data-touch-target^="utility-"]')).toBeNull();
  });

  it.each([
    ["low", "0.35"],
    ["medium", "0.55"],
    ["high", "0.8"],
  ] as const)("applies the %s controller opacity choice", (choice, expected) => {
    const { gamepad, shell } = createGamepad();

    gamepad.setOpacity(choice);

    expect(shell.querySelector<HTMLCanvasElement>("canvas")!.style.opacity).toBe(expected);
    expect(localStorage.getItem("gv:touch-opacity")).toBe(choice);
  });

  it("applies size presets to the current console orientation without moving control centers", () => {
    const { gamepad } = createGamepad("horizontal");
    const before = gamepad._face.map((zone: { x: number; y: number; w: number; h: number }) => ({
      x: zone.x + zone.w / 2,
      y: zone.y + zone.h / 2,
      w: zone.w,
      h: zone.h,
    }));

    gamepad.setSizePreset("large");

    gamepad._face.forEach((zone: { x: number; y: number; w: number; h: number }, index: number) => {
      expect(zone.x + zone.w / 2).toBeCloseTo(before[index].x);
      expect(zone.y + zone.h / 2).toBeCloseTo(before[index].y);
      expect(zone.w).toBeGreaterThan(before[index].w);
      expect(zone.h).toBeGreaterThan(before[index].h);
    });
    expect(JSON.parse(localStorage.getItem(layoutKeyV3)!)["nes:horizontal"]).toBeDefined();
    expect(JSON.parse(localStorage.getItem(layoutKeyV3)!)["nes:vertical"]).toBeUndefined();
    expect(gamepad.getSizePreset()).toBe("large");
    expect(localStorage.getItem(sizePresetKey)).toBe("large");
  });

  it("defaults size to standard and restores a persisted preset after reload", () => {
    const first = createGamepad("horizontal").gamepad;
    expect(first.getSizePreset()).toBe("standard");

    first.setSizePreset("compact");
    const reloaded = new (TouchGamepad as any)(document.createElement("video"), {
      preset: "nes",
      layout: "horizontal",
    });

    expect(reloaded.getSizePreset()).toBe("compact");
    expect(localStorage.getItem(sizePresetKey)).toBe("compact");
  });

  it("marks a freeform resize custom while a position-only move preserves the preset", () => {
    const { gamepad, shell } = createGamepad("horizontal");
    gamepad.setSizePreset("large");
    const target = shell.querySelector<HTMLElement>('[data-touch-target="dpad"]')!;
    const move = (mode: "move" | "resize", delta = 0.05) => {
      gamepad._dragTarget = { kind: mode, zone: "dpad", ...(mode === "resize" ? { tag: "dpad:se" } : {}) };
      gamepad._dragStart = {
        fingerId: 41, nx: 0.1, ny: 0.1,
        tx: gamepad._dpad.x, ty: gamepad._dpad.y, tw: gamepad._dpad.w, th: gamepad._dpad.h,
        mode,
      };
      gamepad._activePointers.set(41, { identifier: 41, clientX: 84.4, clientY: 39, target });
      gamepad._onPointerMove(Object.assign(new MouseEvent("pointermove", {
        clientX: (0.1 + delta) * 844, clientY: (0.1 + delta) * 390, bubbles: true, cancelable: true,
      }), { pointerId: 41 }));
    };

    move("move");
    expect(gamepad.getSizePreset()).toBe("large");
    move("resize", 0);
    expect(gamepad.getSizePreset()).toBe("large");
    move("resize");
    expect(gamepad.getSizePreset()).toBe("custom");
    expect(localStorage.getItem(sizePresetKey)).toBe("custom");
  });

  it("resets only the active console orientation layout", () => {
    const horizontal = computeDefaults("nes", "horizontal");
    const vertical = computeDefaults("nes", "vertical");
    horizontal.dpad.x = 0.18;
    vertical.dpad.x = 0.22;
    localStorage.setItem(layoutKeyV3, JSON.stringify({
      "nes:horizontal": horizontal,
      "nes:vertical": vertical,
    }));
    const { gamepad } = createGamepad("horizontal");

    gamepad.resetLayout();

    expect(gamepad._dpad).toEqual(computeDefaults("nes", "horizontal").dpad);
    const stored = JSON.parse(localStorage.getItem(layoutKeyV3)!);
    expect(stored["nes:horizontal"]).toBeUndefined();
    expect(stored["nes:vertical"].dpad.x).toBe(0.22);
  });

  it("restores independently customized portrait and landscape layouts without drift", () => {
    const { gamepad } = createGamepad("vertical");
    const portrait = { x: 0.17, y: 0.61 };
    gamepad._dpad.x = portrait.x;
    gamepad._dpad.y = portrait.y;
    gamepad.exitEditMode();

    gamepad.setLayout("horizontal");
    const landscape = { x: 0.08, y: 0.52 };
    gamepad._dpad.x = landscape.x;
    gamepad._dpad.y = landscape.y;
    gamepad.exitEditMode();

    gamepad.setLayout("vertical");
    expect(gamepad._dpad).toEqual(expect.objectContaining(portrait));
    gamepad.setLayout("horizontal");
    expect(gamepad._dpad).toEqual(expect.objectContaining(landscape));
    gamepad.setLayout("vertical");
    expect(gamepad._dpad).toEqual(expect.objectContaining(portrait));

    const stored = JSON.parse(localStorage.getItem(layoutKeyV3)!);
    expect(stored["nes:vertical"].dpad).toEqual(expect.objectContaining(portrait));
    expect(stored["nes:horizontal"].dpad).toEqual(expect.objectContaining(landscape));
  });

  it("applies full-viewport four-edge safe-area geometry to portrait canvas and target layer", () => {
    const { shell } = createGamepad("vertical");
    const canvas = shell.querySelector<HTMLCanvasElement>("canvas")!;
    const layer = shell.querySelector<HTMLElement>("[data-touch-islands]")!;
    const targets = Array.from(shell.querySelectorAll<HTMLElement>("[data-touch-target]"));

    for (const edge of ["left", "right", "top", "bottom"] as const) {
      expect(canvas.style.getPropertyValue(`--touch-safe-${edge}`))
        .toContain(`safe-area-inset-${edge}`);
      expect(canvas.style.getPropertyValue(edge)).toContain(`--touch-safe-${edge}`);
      expect(layer.style.getPropertyValue(edge)).toBe(canvas.style.getPropertyValue(edge));
      expect(layer.style.getPropertyValue(`--touch-safe-${edge}`))
        .toBe(canvas.style.getPropertyValue(`--touch-safe-${edge}`));
    }
    expect(canvas.style.top).toBe("var(--touch-safe-top, 0px)");
    expect(canvas.style.bottom).toBe("var(--touch-safe-bottom, 0px)");
    expect(canvas.style.getPropertyValue("--touch-safe-top")).toBe("env(safe-area-inset-top, 0px)");
    expect(canvas.style.getPropertyValue("--touch-safe-bottom")).toBe("env(safe-area-inset-bottom, 0px)");
    expect(canvas.style.height).toContain("100vh");
    expect(canvas.style.height).not.toContain("50vh");
    expect(targets.length).toBeGreaterThanOrEqual(5);
    expect(targets.every((target) => Number.parseFloat(target.style.minWidth) >= 44)).toBe(true);
    expect(targets.every((target) => Number.parseFloat(target.style.minHeight) >= 44)).toBe(true);
    expect(targets.every((target) => target.style.width.endsWith("%"))).toBe(true);
    expect(targets.every((target) => target.style.height.endsWith("%"))).toBe(true);
    expect(targets.every((target) => target.style.borderWidth === "2px")).toBe(true);
    expect(targets.every((target) => !target.style.left.includes("touch-safe"))).toBe(true);
    expect(targets.every((target) => !target.style.top.includes("touch-safe"))).toBe(true);
  });

  it("leaves the upper portrait half pass-through while controls default to the lower half", () => {
    const { gamepad, shell } = createGamepad("vertical");
    const canvas = shell.querySelector<HTMLCanvasElement>("canvas")!;
    const layer = shell.querySelector<HTMLElement>("[data-touch-islands]")!;
    const targets = Array.from(layer.querySelectorAll<HTMLElement>("[data-touch-target]"));
    const onInput = vi.fn();
    gamepad.onInput = onInput;

    expect(canvas.style.pointerEvents).toBe("none");
    expect(layer.style.pointerEvents).toBe("none");
    expect(targets.every((target) => Number(target.dataset.normY) >= 0.5)).toBe(true);
    dispatchPointer(layer, "pointerdown", 400, 100, 90);
    expect(onInput).not.toHaveBeenCalled();

    const defaults = computeDefaults("nes", "vertical");
    expect(defaults.dpad).toEqual({ x: 0.03, y: 0.54, w: 0.24, h: 0.26 });
    expect(defaults.system[0]).toEqual(expect.objectContaining({ y: 0.9, h: 0.06 }));
  });

  it("migrates v2 portrait geometry once into full-shell v3 coordinates", () => {
    const vertical = {
      dpad: { x: 0.17, y: 0.12, w: 0.29, h: 0.4 },
      face: [
        { x: 0.61, y: 0.2, w: 0.13, h: 0.18, label: "B" },
        { x: 0.79, y: 0.3, w: 0.14, h: 0.2, label: "A" },
      ],
      system: [
        { x: 0.34, y: 0.76, w: 0.12, h: 0.14, label: "SELECT" },
        { x: 0.54, y: 0.78, w: 0.13, h: 0.16, label: "START" },
      ],
    };
    const horizontal = computeDefaults("nes", "horizontal");
    horizontal.dpad.x = 0.11;
    localStorage.setItem(layoutKeyV2, JSON.stringify({
      "nes:vertical": vertical,
      "nes:horizontal": horizontal,
    }));

    const first = createGamepad("vertical").gamepad;
    expect(first._dpad).toEqual({ x: 0.17, y: 0.56, w: 0.29, h: 0.2 });
    expect(first._face[0]).toEqual({ x: 0.61, y: 0.6, w: 0.13, h: 0.09, label: "B" });
    expect(first._system[1]).toEqual({ x: 0.54, y: 0.89, w: 0.13, h: 0.08, label: "START" });

    const migrated = JSON.parse(localStorage.getItem(layoutKeyV3)!);
    expect(migrated["nes:vertical"].dpad).toEqual(first._dpad);
    expect(migrated["nes:horizontal"]).toEqual(horizontal);
    expect(JSON.parse(localStorage.getItem(layoutKeyV2)!)["nes:vertical"]).toEqual(vertical);

    const changedV2 = JSON.parse(localStorage.getItem(layoutKeyV2)!);
    changedV2["nes:vertical"].dpad.y = 0;
    localStorage.setItem(layoutKeyV2, JSON.stringify(changedV2));
    const second = new (TouchGamepad as any)(document.createElement("video"), { preset: "nes", layout: "vertical" });
    expect(second._dpad).toEqual(first._dpad);
  });

  it("keeps a successfully migrated v2 layout in memory when the v3 write exceeds quota", () => {
    const vertical = computeDefaults("nes", "vertical");
    vertical.dpad.x = 0.17;
    localStorage.setItem(layoutKeyV2, JSON.stringify({ "nes:vertical": vertical }));
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation((key) => {
      if (key === layoutKeyV3) throw new DOMException("Storage quota exceeded", "QuotaExceededError");
    });

    const gamepad = new (TouchGamepad as any)(document.createElement("video"), {
      preset: "nes",
      layout: "vertical",
    });

    expect(gamepad._dpad.x).toBe(0.17);
    expect(gamepad._face.map((button: { label: string }) => button.label)).toEqual(["B", "A"]);
    expect(setItem).toHaveBeenCalledWith(layoutKeyV3, expect.any(String));
  });

  it.each([
    ["nes", ["B", "A"]],
    ["snes", ["B", "A", "Y", "X"]],
  ] as const)("swaps %s face geometry without changing semantic indices and reloads it", (preset, labels) => {
    const { gamepad, shell } = createGamepad("horizontal", preset);
    const before = gamepad._face.map((button: { x: number; y: number; w: number; h: number }) => ({
      x: button.x, y: button.y, w: button.w, h: button.h,
    }));
    const onInput = vi.fn();
    gamepad.onInput = onInput;

    gamepad.swapAB();

    expect(gamepad._face.map((button: { label: string }) => button.label)).toEqual(labels);
    expect(gamepad._face[0]).toEqual(expect.objectContaining(before[1]));
    expect(gamepad._face[1]).toEqual(expect.objectContaining(before[0]));
    if (labels.length === 4) {
      expect(gamepad._face[2]).toEqual(expect.objectContaining(before[3]));
      expect(gamepad._face[3]).toEqual(expect.objectContaining(before[2]));
    }

    const semanticButton = shell.querySelector<HTMLElement>('[data-touch-target="face-0"]')!;
    const semanticZone = gamepad._face[0];
    dispatchPointer(
      semanticButton,
      "pointerdown",
      (semanticZone.x + semanticZone.w / 2) * 844,
      (semanticZone.y + semanticZone.h / 2) * 390,
      71,
    );
    expect(onInput).toHaveBeenLastCalledWith(expect.objectContaining({
      face: labels.map((_, index) => index === 0),
    }));

    const stored = JSON.parse(localStorage.getItem(layoutKeyV3)!)[`${preset}:horizontal`];
    expect(stored.face.map((button: { label: string }) => button.label)).toEqual(labels);
    const reloaded = new (TouchGamepad as any)(document.createElement("video"), {
      preset,
      layout: "horizontal",
    });
    expect(reloaded._face).toEqual(gamepad._face);
    expect(reloaded._face.map((button: { label: string }) => button.label)).toEqual(labels);
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

    expect(gamepad._canvas?.style.filter).toBe("brightness(0.45)");
    expect(layer.style.pointerEvents).toBe("none");
    expect(onInput).toHaveBeenLastCalledWith({
      dpad: [false, false, false, false],
      face: [false, false],
      system: [false, false],
    });

    gamepad.resumeInput();
    expect(gamepad._canvas?.style.filter).toBe("");
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

  it.each([
    ["face", "face-0", "_face", 0],
    ["system", "system-0", "_system", 0],
  ] as const)("moves the %s button independently in edit mode", (_name, targetName, collection, index) => {
    const { gamepad, shell } = createGamepad();
    gamepad.enterEditMode();
    const target = shell.querySelector<HTMLElement>(`[data-touch-target="${targetName}"]`)!;
    const zone = gamepad[collection][index];
    const startX = (zone.x + zone.w / 2) * 844;
    const startY = (zone.y + zone.h / 2) * 390;
    const before = zone.x;

    dispatchPointer(target, "pointerdown", startX, startY, 31);
    dispatchPointer(target, "pointermove", startX - 48, startY, 31);
    dispatchPointer(target, "pointerup", startX - 48, startY, 31);

    expect(zone.x).toBeLessThan(before);
  });

  it.each([
    ["face", "face-0", "_face", 0],
    ["system", "system-0", "_system", 0],
  ] as const)("resizes the %s button with a finger-sized corner handle", (_name, targetName, collection, index) => {
    const { gamepad, shell } = createGamepad();
    gamepad.enterEditMode();
    const target = shell.querySelector<HTMLElement>(`[data-touch-target="${targetName}"]`)!;
    const zone = gamepad[collection][index];
    const cornerX = (zone.x + zone.w) * 844;
    const cornerY = (zone.y + zone.h) * 390;
    const beforeWidth = zone.w;

    dispatchPointer(target, "pointerdown", cornerX - 18, cornerY - 18, 32);
    expect(gamepad._dragTarget).toEqual(expect.objectContaining({ kind: "resize", zone: _name, index }));
    dispatchPointer(target, "pointermove", cornerX + 38, cornerY + 38, 32);
    dispatchPointer(target, "pointerup", cornerX + 38, cornerY + 38, 32);

    expect(zone.w).toBeGreaterThan(beforeWidth);
  });

  it.each([
    ["face", "face-0", "_face", 0],
    ["system", "system-0", "_system", 0],
  ] as const)("keeps the %s button at least 56px wide and tall while resizing", (_name, targetName, collection, index) => {
    const { gamepad, shell } = createGamepad();
    gamepad.enterEditMode();
    const target = shell.querySelector<HTMLElement>(`[data-touch-target="${targetName}"]`)!;
    const zone = gamepad[collection][index];
    const cornerX = (zone.x + zone.w) * 844;
    const cornerY = (zone.y + zone.h) * 390;

    dispatchPointer(target, "pointerdown", cornerX - 8, cornerY - 8, 35);
    dispatchPointer(target, "pointermove", zone.x * 844 + 4, zone.y * 390 + 4, 35);
    dispatchPointer(target, "pointerup", zone.x * 844 + 4, zone.y * 390 + 4, 35);

    expect(Math.round(zone.w * 844)).toBeGreaterThanOrEqual(56);
    expect(Math.round(zone.h * 390)).toBeGreaterThanOrEqual(56);
  });

  it("restores undersized saved buttons to the 56px minimum on layout", () => {
    const { gamepad } = createGamepad();
    gamepad._face[0].w = 0.01;
    gamepad._face[0].h = 0.01;

    gamepad._resizeCanvas();

    expect(Math.round(gamepad._face[0].w * 844)).toBeGreaterThanOrEqual(56);
    expect(Math.round(gamepad._face[0].h * 390)).toBeGreaterThanOrEqual(56);
  });

  it("chooses the touched button when broad resize handles overlap", () => {
    const { gamepad, shell } = createGamepad();
    gamepad.enterEditMode();
    const face = shell.querySelector<HTMLElement>('[data-touch-target="face-1"]')!;
    const zone = gamepad._face[1];
    const cornerX = zone.x * 844;
    const cornerY = zone.y * 390;

    dispatchPointer(face, "pointerdown", cornerX + 8, cornerY + 8, 33);

    expect(gamepad._dragTarget).toEqual(expect.objectContaining({ kind: "resize", zone: "face", index: 1 }));
  });

  it("stays in edit mode after completing a resize", () => {
    const { gamepad, shell } = createGamepad();
    gamepad.enterEditMode();
    const system = shell.querySelector<HTMLElement>('[data-touch-target="system-0"]')!;
    const zone = gamepad._system[0];
    const x = (zone.x + zone.w) * 844;
    const y = (zone.y + zone.h) * 390;

    dispatchPointer(system, "pointerdown", x - 8, y - 8, 34);
    dispatchPointer(system, "pointermove", x + 30, y + 20, 34);
    dispatchPointer(system, "pointerup", x + 30, y + 20, 34);

    expect(gamepad._editMode).toBe(true);
  });

  it("draws four visible resize handles for face and system buttons", () => {
    const source = readFileSync("lib/touch-gamepad/index.ts", "utf8");
    expect(source).toContain("drawResizeHandles(ctx, this._face[i]");
    expect(source).toContain("drawResizeHandles(ctx, this._system[i]");
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
