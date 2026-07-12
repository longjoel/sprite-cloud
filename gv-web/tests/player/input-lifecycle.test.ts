// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TouchGamepad } from "../../lib/touch-gamepad/index";
import { computeDefaults } from "../../lib/touch-gamepad/presets";
import { GAMEPAD_MASK } from "../../public/player/input-mapping.js";
import { GvPlayer } from "../../public/player/gv-player.js";

const layoutKey = "gv:touch-layouts-v2";
const rect = (label: string, x: number) => ({ x, y: 0.2, w: 0.1, h: 0.1, label });

describe("persisted touch layouts", () => {
  beforeEach(() => localStorage.clear());

  it("migrates an old SNES system group while preserving compatible dpad and face geometry", () => {
    const old = {
      dpad: { x: 0.11, y: 0.22, w: 0.33, h: 0.44 },
      face: [rect("B", 0.51), rect("A", 0.62), rect("Y", 0.73), rect("X", 0.84)],
      system: [rect("SELECT", 0.4), rect("START", 0.55)],
    };
    localStorage.setItem(layoutKey, JSON.stringify({ "snes:horizontal": old }));

    const pad = new (TouchGamepad as any)({} as HTMLVideoElement, { preset: "snes", layout: "horizontal" });
    expect(pad._dpad).toEqual(old.dpad);
    expect(pad._face).toEqual(old.face);
    expect(pad._system).toEqual(computeDefaults("snes", "horizontal").system);
    expect(pad._system.map((button: { label: string }) => button.label)).toEqual(["L", "SELECT", "START", "R"]);
    expect(JSON.parse(localStorage.getItem(layoutKey)!)["snes:horizontal"].system).toEqual(pad._system);
  });

  it("keeps a fully compatible stored layout unchanged", () => {
    const stored = computeDefaults("snes", "vertical");
    stored.dpad.x = 0.19;
    stored.face[0].x = 0.61;
    stored.system[0].x = 0.07;
    localStorage.setItem(layoutKey, JSON.stringify({ "snes:vertical": stored }));

    const pad = new (TouchGamepad as any)({} as HTMLVideoElement, { preset: "snes", layout: "vertical" });
    expect({ dpad: pad._dpad, face: pad._face, system: pad._system }).toEqual(stored);
  });
});

function gamepad(button = -1) {
  const buttons = Array.from({ length: 16 }, (_, index) => ({ pressed: index === button }));
  return { id: `pad-${button}`, buttons, axes: [] };
}

function packet(buffer: ArrayBuffer): number[] {
  return [...new Uint8Array(buffer)];
}

describe("physical gamepad lifecycle", () => {
  let frame: FrameRequestCallback | undefined;
  beforeEach(() => {
    frame = undefined;
    vi.stubGlobal("requestAnimationFrame", vi.fn((callback: FrameRequestCallback) => { frame = callback; return 1; }));
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
  });
  afterEach(() => vi.unstubAllGlobals());

  function harness(pads: Array<any>, baseSeat = 0) {
    const sent: number[][] = [];
    let current = pads;
    vi.stubGlobal("navigator", { getGamepads: () => current });
    const player: any = Object.create(GvPlayer.prototype);
    player._seat = baseSeat;
    player._inputState = 1 << 13; // keyboard-owned bit
    player._sendMask = vi.fn(() => sent.push([player._seat, player._inputState & 0xff, player._inputState >> 8]));
    player._dc = { readyState: "open", send: (value: ArrayBuffer) => sent.push(packet(value)), close: vi.fn() };
    player._gamepadMapping = undefined;
    player._gamepadRAF = null;
    player._setupGamepadInput();
    const poll = () => frame?.(0);
    return { player, sent, poll, setPads: (next: Array<any>) => { current = next; } };
  }

  it("compacts a slot-1-only browser array into local seat zero", () => {
    const h = harness([null, gamepad(0)]);
    h.poll();
    expect(h.sent).toEqual([[0, 1, 32]]);
    expect(h.player._inputState & (1 << 13)).not.toBe(0);
  });

  it("releases seat zero gamepad bits on disconnect without clearing keyboard bits", () => {
    const h = harness([gamepad(0)]);
    h.poll();
    h.setPads([]);
    h.poll();
    expect(h.sent.at(-1)).toEqual([0, 0, 32]);
    expect(h.player._inputState & GAMEPAD_MASK).toBe(0);
    expect(h.player._inputState & (1 << 13)).not.toBe(0);
  });

  it("releases higher seats and remaps remaining pads when topology shrinks", () => {
    const first = gamepad(0);
    const second = gamepad(1);
    const h = harness([first, second]);
    h.poll();
    h.sent.length = 0;
    h.setPads([null, second]);
    h.poll();
    expect(h.sent).toContainEqual([1, 0, 0]);
    expect(h.sent).toContainEqual([0, 0, 33]);
  });

  it("caps physical controllers at the four authenticated local ports", () => {
    const h = harness([gamepad(0), gamepad(0), gamepad(0), gamepad(0), gamepad(0)]);
    h.poll();
    expect(h.sent.map(([seat]) => seat)).toEqual([0, 1, 2, 3]);
  });

  it("caps controllers to the remaining protocol ports for a nonzero base seat", () => {
    const h = harness([gamepad(0), gamepad(0), gamepad(0), gamepad(0)], 2);
    h.poll();
    expect(h.sent.map(([seat]) => seat)).toEqual([2, 3]);
    expect(h.sent.some(([seat]) => seat > 3)).toBe(false);
  });
});
