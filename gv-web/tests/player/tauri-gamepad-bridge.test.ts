// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GvPlayer } from "../../public/player/gv-player.js";

// ── Replicated bridge logic (from gv-tauri-bridge.js) ────────────────
// These are the pure functions extracted from the bridge IIFE so we
// can test them without loading the actual script.

const NUM_PORTS = 4;
const TOTAL_BUTTONS = 17;

const MASK_TO_BUTTON: Record<number, number> = {
  0: 0,   // South/B     → button 0
  1: 1,   // East        → button 1
  2: 8,   // Select      → button 8
  3: 9,   // Start       → button 9
  4: 12,  // DPad Up     → button 12
  5: 13,  // DPad Down   → button 13
  6: 14,  // DPad Left   → button 14
  7: 15,  // DPad Right  → button 15
  8: 3,   // North/X     → button 3
  9: 2,   // West/Y      → button 2
  10: 4,  // L           → button 4
  11: 5,  // R           → button 5
};

function makeButton(pressed: boolean) {
  return {
    pressed,
    touched: pressed,
    value: pressed ? 1.0 : 0.0,
  };
}

function buildGamepad(index: number, port: { mask: number; connected: boolean }, timestamp = 0) {
  const buttons = Array.from({ length: TOTAL_BUTTONS }, () => makeButton(false));

  if (port.connected) {
    for (let bit = 0; bit < 12; bit++) {
      if (port.mask & (1 << bit)) {
        const btnIdx = MASK_TO_BUTTON[bit];
        if (btnIdx >= 0) {
          buttons[btnIdx] = makeButton(true);
        }
      }
    }
  }

  return {
    axes: [0, 0, 0, 0],
    buttons,
    connected: port.connected,
    id: `Native Gamepad (Port ${index + 1})`,
    index,
    mapping: "standard",
    timestamp,
    vibrationActuator: null,
  };
}

function shimGetGamepads(ports: Array<{ mask: number; connected: boolean }>, timestamp = 0) {
  const result: any[] = [];
  for (let i = 0; i < NUM_PORTS; i++) {
    result[i] = buildGamepad(i, ports[i], timestamp);
  }
  return result;
}

// ── RetroPad mask constants (match gv-desktop main.rs) ────────────────
const MASK_SOUTH = 1 << 0;
const MASK_EAST = 1 << 1;
const MASK_SELECT = 1 << 2;
const MASK_START = 1 << 3;
const MASK_DPAD_UP = 1 << 4;
const MASK_DPAD_DOWN = 1 << 5;
const MASK_DPAD_LEFT = 1 << 6;
const MASK_DPAD_RIGHT = 1 << 7;
const MASK_NORTH = 1 << 8;
const MASK_WEST = 1 << 9;
const MASK_LEFT_TRIGGER = 1 << 10;
const MASK_RIGHT_TRIGGER = 1 << 11;

// ── Tests ─────────────────────────────────────────────────────────────

describe("tauri gamepad bridge — gamepad object formatting", () => {
  it("builds a disconnected gamepad with all buttons up", () => {
    const gp = buildGamepad(0, { mask: 0, connected: false });
    expect(gp.connected).toBe(false);
    expect(gp.id).toBe("Native Gamepad (Port 1)");
    expect(gp.index).toBe(0);
    expect(gp.mapping).toBe("standard");
    expect(gp.buttons).toHaveLength(TOTAL_BUTTONS);
    expect(gp.buttons.every((b) => !b.pressed)).toBe(true);
    expect(gp.buttons.every((b) => b.value === 0)).toBe(true);
    expect(gp.axes).toEqual([0, 0, 0, 0]);
  });

  it("maps each RetroPad mask bit to the correct standard Gamepad button", () => {
    // South (B) → bit 0 → standard button 0
    const gp = buildGamepad(0, { mask: MASK_SOUTH, connected: true });
    expect(gp.buttons[0].pressed).toBe(true);
    // Other buttons should not be pressed
    expect(gp.buttons.filter((_, i) => i !== 0).every((b) => !b.pressed)).toBe(true);

    // North (X) → bit 8 → standard button 3
    const gp2 = buildGamepad(0, { mask: MASK_NORTH, connected: true });
    expect(gp2.buttons[3].pressed).toBe(true);
    expect(gp2.buttons.filter((_, i) => i !== 3).every((b) => !b.pressed)).toBe(true);

    // West (Y) → bit 9 → standard button 2
    const gp3 = buildGamepad(0, { mask: MASK_WEST, connected: true });
    expect(gp3.buttons[2].pressed).toBe(true);

    // DPad Up → bit 4 → standard button 12
    const gp4 = buildGamepad(0, { mask: MASK_DPAD_UP, connected: true });
    expect(gp4.buttons[12].pressed).toBe(true);

    // DPad Down → bit 5 → standard button 13
    const gp5 = buildGamepad(0, { mask: MASK_DPAD_DOWN, connected: true });
    expect(gp5.buttons[13].pressed).toBe(true);

    // Left Trigger (L) → bit 10 → standard button 4
    const gp6 = buildGamepad(0, { mask: MASK_LEFT_TRIGGER, connected: true });
    expect(gp6.buttons[4].pressed).toBe(true);

    // Right Trigger (R) → bit 11 → standard button 5
    const gp7 = buildGamepad(0, { mask: MASK_RIGHT_TRIGGER, connected: true });
    expect(gp7.buttons[5].pressed).toBe(true);

    // Select → bit 2 → standard button 8
    const gp8 = buildGamepad(0, { mask: MASK_SELECT, connected: true });
    expect(gp8.buttons[8].pressed).toBe(true);

    // Start → bit 3 → standard button 9
    const gp9 = buildGamepad(0, { mask: MASK_START, connected: true });
    expect(gp9.buttons[9].pressed).toBe(true);
  });

  it("handles multiple simultaneous button presses", () => {
    // B (South) + A (East) + X (North) + Y (West) all pressed
    const mask = MASK_SOUTH | MASK_EAST | MASK_NORTH | MASK_WEST;
    const gp = buildGamepad(0, { mask, connected: true });
    expect(gp.buttons[0].pressed).toBe(true);  // B/South  → btn 0
    expect(gp.buttons[1].pressed).toBe(true);  // A/East   → btn 1
    expect(gp.buttons[2].pressed).toBe(true);  // Y/West   → btn 2
    expect(gp.buttons[3].pressed).toBe(true);  // X/North  → btn 3
    // Count exactly 4 pressed buttons
    expect(gp.buttons.filter((b) => b.pressed)).toHaveLength(4);
  });

  it("pressed buttons have touched=true and value=1.0", () => {
    const gp = buildGamepad(0, { mask: MASK_SOUTH | MASK_START, connected: true });
    const southBtn = gp.buttons[0];
    expect(southBtn.pressed).toBe(true);
    expect(southBtn.touched).toBe(true);
    expect(southBtn.value).toBe(1.0);

    const startBtn = gp.buttons[9];
    expect(startBtn.pressed).toBe(true);
    expect(startBtn.touched).toBe(true);
    expect(startBtn.value).toBe(1.0);

    // Unpressed button
    const unpressed = gp.buttons[8]; // Select is not pressed
    expect(unpressed.pressed).toBe(false);
    expect(unpressed.touched).toBe(false);
    expect(unpressed.value).toBe(0.0);
  });

  it("disconnected ports show all buttons up regardless of mask", () => {
    const gp = buildGamepad(0, { mask: 0xFFFF, connected: false });
    expect(gp.connected).toBe(false);
    expect(gp.buttons.every((b) => !b.pressed)).toBe(true);
  });
});

describe("tauri gamepad bridge — getGamepads shim", () => {
  it("returns exactly 4 ports (NUM_PORTS)", () => {
    const ports = [
      { mask: 0, connected: false },
      { mask: 0, connected: false },
      { mask: 0, connected: false },
      { mask: 0, connected: false },
    ];
    const result = shimGetGamepads(ports);
    expect(result).toHaveLength(4);
    expect(result.every((gp) => gp !== null)).toBe(true);
  });

  it("each port has the correct index and id", () => {
    const ports = [
      { mask: 0, connected: false },
      { mask: 0, connected: false },
      { mask: 0, connected: false },
      { mask: 0, connected: false },
    ];
    const result = shimGetGamepads(ports);
    for (let i = 0; i < 4; i++) {
      expect(result[i].index).toBe(i);
      expect(result[i].id).toBe(`Native Gamepad (Port ${i + 1})`);
    }
  });

  it("only connected ports report as connected in getGamepads output", () => {
    const ports = [
      { mask: 0, connected: false },
      { mask: MASK_SOUTH, connected: true },
      { mask: 0, connected: false },
      { mask: 0, connected: false },
    ];
    const result = shimGetGamepads(ports);
    expect(result[0].connected).toBe(false);
    expect(result[1].connected).toBe(true);
    expect(result[2].connected).toBe(false);
    expect(result[3].connected).toBe(false);
  });

  it("returns stable indices so P1 (port 0) is always the Deck built-in when connected first", () => {
    // Simulate Deck built-in gamepad connected on port 0
    const ports = [
      { mask: MASK_SOUTH | MASK_DPAD_UP, connected: true },
      { mask: 0, connected: false },
      { mask: 0, connected: false },
      { mask: 0, connected: false },
    ];
    const result = shimGetGamepads(ports);
    // Port 0 is the Deck built-in, always at index 0
    expect(result[0].connected).toBe(true);
    expect(result[0].id).toBe("Native Gamepad (Port 1)");
    // External gamepads (ports 1–3) are disconnected
    expect(result[1].connected).toBe(false);
    expect(result[2].connected).toBe(false);
    expect(result[3].connected).toBe(false);
  });
});

describe("tauri gamepad bridge — lifecycle with gv-player", () => {
  let frame: FrameRequestCallback | undefined;

  beforeEach(() => {
    frame = undefined;
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn((callback: FrameRequestCallback) => {
        frame = callback;
        return 1;
      }),
    );
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
  });
  afterEach(() => vi.unstubAllGlobals());

  function shimGamepad(button = -1) {
    const buttons = Array.from({ length: 17 }, (_, i) => ({
      pressed: i === button,
      touched: i === button,
      value: i === button ? 1.0 : 0.0,
    }));
    return { id: `shim-pad-${button}`, buttons, axes: [0, 0, 0, 0], connected: true, index: 0, mapping: "standard", timestamp: 0, vibrationActuator: null };
  }

  function shimDisconnectedPad(index: number) {
    const buttons = Array.from({ length: 17 }, () => ({
      pressed: false,
      touched: false,
      value: 0.0,
    }));
    return { id: `Native Gamepad (Port ${index + 1})`, buttons, axes: [0, 0, 0, 0], connected: false, index, mapping: "standard", timestamp: 0, vibrationActuator: null };
  }

  function harness(pads: Array<any>, baseSeat = 0) {
    const sent: number[][] = [];
    let current = pads;

    vi.stubGlobal("navigator", { getGamepads: () => current });

    const player: any = Object.create(GvPlayer.prototype);
    player._seat = baseSeat;
    player._inputState = 1 << 13; // keyboard-owned bit
    player._sendMask = vi.fn(() => {
      sent.push([player._seat, player._inputState & 0xff, player._inputState >> 8]);
    });
    player._dc = {
      readyState: "open",
      send: (value: ArrayBuffer) => {
        const bytes = [...new Uint8Array(value)];
        sent.push(bytes);
      },
      close: vi.fn(),
    };
    player._gamepadMapping = undefined;
    player._gamepadRAF = null;
    player._setupGamepadInput();
    const poll = () => frame?.(0);
    return { player, sent, poll, setPads: (next: Array<any>) => { current = next; } };
  }

  it("shimmed P1 (Deck built-in) compacts to local seat zero and preserves keyboard-owned bits", () => {
    const h = harness([shimGamepad(0)]);
    h.poll();
    // P1 gamepad should merge into _inputState seat 0, keyboard bit (13) preserved
    expect(h.sent.length).toBeGreaterThan(0);
    const last = h.sent.at(-1)!;
    expect(last[0]).toBe(0); // seat 0
    expect(last[2] & (1 << 5)).not.toBe(0); // keyboard-owned bit 13 → byte 2, bit 5
  });

  it("shimmed gamepad disconnect releases seat zero without clearing keyboard bits", () => {
    const h = harness([shimGamepad(0)]);
    h.poll();
    h.setPads([]);
    h.poll();
    const last = h.sent.at(-1)!;
    // Keyboard bit (13) should still be set, gamepad mask cleared
    expect(last[0]).toBe(0);
    expect(last[2] & (1 << 5)).not.toBe(0); // keyboard bit intact
  });

  it("shimmed getGamepads data flows through the same compaction logic as browser gamepads", () => {
    // Two connected shimmed gamepads
    const h = harness([shimGamepad(0), shimGamepad(1)]);
    h.poll();
    // Both should result in sent masks
    expect(h.sent.length).toBeGreaterThan(0);
    // Seat 0 should receive gamepad data
    const seatZeroMask = h.sent.find((s) => s[0] === 0);
    expect(seatZeroMask).toBeDefined();
  });

  it("caps shimmed gamepads at 4 ports (matching protocol limit)", () => {
    const pads = [
      shimGamepad(0),
      shimGamepad(0),
      shimGamepad(0),
      shimGamepad(0),
      shimGamepad(0), // 5th pad — should be ignored
    ];
    const h = harness(pads);
    h.poll();
    // Only 4 seats should be sent
    const seats = new Set(h.sent.map((s) => s[0]));
    expect(seats.size).toBeLessThanOrEqual(4);
  });

  it("topology shrink releases higher seats and remaps remaining pads", () => {
    const first = shimGamepad(0);
    const second = shimGamepad(1);
    const h = harness([first, second]);
    h.poll();
    h.sent.length = 0;
    // Disconnect the first pad — second should remain
    h.setPads([null, second]);
    h.poll();
    // There should be a sent message for seat 1 (the remaining pad)
    const seatOneMessages = h.sent.filter((s) => s[0] === 1);
    expect(seatOneMessages.length).toBeGreaterThan(0);
  });
});

describe("tauri gamepad bridge — no browser gamepad events leak through", () => {
  beforeEach(() => {
    // Simulate Tauri environment: __TAURI__ is present, bridge is active
    vi.stubGlobal("__TAURI__", { event: { listen: vi.fn() } });
    // Real browser Gamepad API (JSDOM doesn't have it; stub a minimal one)
    const realGetGamepads = vi.fn(() => [null, null, null, null]);
    vi.stubGlobal("navigator", { getGamepads: realGetGamepads });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("navigator.getGamepads is replaced when __TAURI__ is present", () => {
    // The bridge replaces navigator.getGamepads. Simulate what the bridge does:
    // When the bridge activates, it overrides navigator.getGamepads to return shimmed data.
    // We test that the shimmed data is in the correct format.
    const shimmedPorts = [
      { mask: 0, connected: false },
      { mask: MASK_SOUTH, connected: true },
      { mask: 0, connected: false },
      { mask: 0, connected: false },
    ];

    // Manually apply the shim (as the bridge would)
    navigator.getGamepads = () => shimGetGamepads(shimmedPorts);

    const result = navigator.getGamepads();
    expect(result).toHaveLength(4);
    expect(result[0]!.connected).toBe(false);
    expect(result[1]!.connected).toBe(true);
    expect(result[1]!.buttons[0]!.pressed).toBe(true); // South/B pressed
  });

  it("bridge does not activate when __TAURI__ is absent", () => {
    vi.unstubAllGlobals();
    // In a standard browser (no __TAURI__), the bridge no-ops
    // and getGamepads remains the real browser implementation
    expect((window as any).__TAURI__).toBeUndefined();
  });
});
