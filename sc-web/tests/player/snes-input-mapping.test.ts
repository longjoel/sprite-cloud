import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  GAMEPAD_MASK,
  standardGamepadToLibretro,
  touchStateToStandardButtons,
} from "../../public/player/input-mapping.js";

import { ScPlayer as CanonicalScPlayer } from "../../public/player/sc-player.js";
import { ScPlayer as PublicScPlayer } from "../../public/player/index.js";

const press = (button: number) => {
  const buttons = new Array(16).fill(false);
  buttons[button] = true;
  return standardGamepadToLibretro(buttons, []);
};

describe("public player entry point", () => {
  it("re-exports the canonical player instead of carrying a stale input implementation", () => {
    expect(PublicScPlayer).toBe(CanonicalScPlayer);
  });

  it("has no obsolete server-side duplicate player bundle", () => {
    const repo = fileURLToPath(new URL("../../..", import.meta.url));
    expect(existsSync(`${repo}/sc-server/src/player_bundle.js`)).toBe(false);
    expect(readFileSync(`${repo}/sc-server/src/player_server.rs`, "utf8")).not.toContain("include_str!(\"player_bundle.js\")");
  });
});

describe("standard gamepad to libretro mapping", () => {
  it.each([
    ["B / bottom", 0, 0],
    ["A / right", 1, 8],
    ["Y / left", 2, 1],
    ["X / top", 3, 9],
    ["L", 4, 10],
    ["R", 5, 11],
  ])("maps SNES %s button %i to exact bit %i", (_name, button, bit) => {
    expect(press(button)).toBe(1 << bit);
  });

  it("includes every physical SNES face and shoulder bit in the gamepad-owned mask", () => {
    const snesBits = [0, 1, 8, 9, 10, 11].reduce((mask, bit) => mask | (1 << bit), 0);
    expect(GAMEPAD_MASK & snesBits).toBe(snesBits);
  });

  it("maps physical standard X, Y, L and R presses together", () => {
    const buttons = new Array(16).fill(false);
    [2, 3, 4, 5].forEach((index) => { buttons[index] = true; });
    expect(standardGamepadToLibretro(buttons, [])).toBe(
      (1 << 1) | (1 << 9) | (1 << 10) | (1 << 11),
    );
  });
});

describe("touch adapter", () => {
  it.each([
    ["A", 0, 2],
    ["B", 1, 0],
    ["C", 2, 1],
  ])("maps Genesis touch %s to its libretro-compatible standard position", (_name, faceIndex, buttonIndex) => {
    const face = new Array(3).fill(false);
    face[faceIndex] = true;
    const buttons = touchStateToStandardButtons("genesis", { dpad: [], face, system: [] });
    expect(buttons[buttonIndex]).toBe(true);
    expect(buttons.filter(Boolean)).toHaveLength(1);
  });

  it("represents SNES B, A, Y and X as canonical standard buttons", () => {
    const buttons = touchStateToStandardButtons("snes", {
      dpad: [false, false, false, false],
      face: [true, true, true, true],
      system: [false, false, false, false],
    });
    expect(buttons.slice(0, 6)).toEqual([true, true, true, true, false, false]);
  });

  it("maps Genesis A/B/C to the core's Y/B/A positions and Start to bit 3", () => {
    const buttons = touchStateToStandardButtons("genesis", {
      dpad: [false, false, false, false],
      face: [true, true, true],
      system: [true],
    });
    expect(standardGamepadToLibretro(buttons)).toBe((1 << 1) | (1 << 0) | (1 << 8) | (1 << 3));
  });

  it.each([
    ["L", 0, 4],
    ["SELECT", 1, 8],
    ["START", 2, 9],
    ["R", 3, 5],
  ])("represents SNES touch %s at standard button %i", (_name, systemIndex, buttonIndex) => {
    const system = new Array(4).fill(false);
    system[systemIndex] = true;
    const buttons = touchStateToStandardButtons("snes", { dpad: [], face: [], system });
    expect(buttons[buttonIndex]).toBe(true);
    expect(buttons.filter(Boolean)).toHaveLength(1);
  });

  it("keeps non-SNES Select and Start system positions compatible", () => {
    const buttons = touchStateToStandardButtons("nes", {
      dpad: [], face: [], system: [true, true],
    });
    expect(buttons[8]).toBe(true);
    expect(buttons[9]).toBe(true);
    expect(buttons.filter(Boolean)).toHaveLength(2);
  });
});
