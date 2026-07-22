// Canonical browser Gamepad API → libretro joypad mapping.
// Handles both "standard" (Xbox/W3C) and non-standard (PS/DirectInput) controllers.

export const GAMEPAD_MASK = Object.freeze(
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]
    .reduce((mask, bit) => mask | (1 << bit), 0),
);

// ── Standard (Xbox-style / W3C) mapping ──────────────────────────
export const STANDARD_MAPPING = Object.freeze({
  // D-pad as buttons
  dpadUp: 12, dpadDown: 13, dpadLeft: 14, dpadRight: 15,
  // System
  start: 9, select: 8,
  // Face (SNES convention: bottom=B, right=A, left=Y, top=X)
  b: 0, a: 1, y: 2, x: 3,
  // Shoulders
  l: 4, r: 5, l2: 6, r2: 7,
  // Sticks
  l3: 10, r3: 11,
  // Axes
  leftStickX: 0, leftStickY: 1, rightStickX: 2, rightStickY: 3,
  axisThreshold: 0.5,
});

// ── PlayStation non-standard (DirectInput / older Bluetooth) ─────
// Common on PS4/PS5 controllers when not using the W3C standard mapping.
export const PS_MAPPING = Object.freeze({
  // PS D-pad is often on axes 6/7 or buttons 4-7
  dpadUp: 12, dpadDown: 13, dpadLeft: 14, dpadRight: 15,
  start: 9, select: 8,
  // PS face is arranged differently
  cross: 0, circle: 1, square: 2, triangle: 3,
  b: 0, a: 1, y: 2, x: 3,
  l1: 4, r1: 5, l2: 6, r2: 7,
  l3: 10, r3: 11,
  leftStickX: 0, leftStickY: 1, rightStickX: 2, rightStickY: 3,
  axisThreshold: 0.5,
  // When dpad is on axes (common on PS), these are the axis indices
  dpadAxisX: null, dpadAxisY: null,
});

// ── 8BitDo Ultimate / Pro 2 (2.4g / D-input mode) ─────────────────
// Reports as "8BitDo Ultimate 2.4G Wireless Controller" or
// "8BitDo Pro 2" — follows Nintendo face layout + PlayStation shoulders.
// D-pad is on buttons 12-15 (hat switch) in 2.4g mode.
export const EIGHTBITDO_MAPPING = Object.freeze({
  dpadUp: 12, dpadDown: 13, dpadLeft: 14, dpadRight: 15,
  start: 11, select: 10,
  // Nintendo face: A(right)=1, B(bottom)=0, X(top)=3, Y(left)=2
  b: 0, a: 1, y: 2, x: 3,
  l: 4, r: 5, l2: 6, r2: 7,
  l3: 8, r3: 9,
  leftStickX: 0, leftStickY: 1, rightStickX: 2, rightStickY: 3,
  axisThreshold: 0.5,
  dpadAxisX: null, dpadAxisY: null,
});

// ── Default (used when mapping is "standard") — same as STANDARD ──
export const DEFAULT_GAMEPAD_MAPPING = STANDARD_MAPPING;

/** Pick a mapping based on gamepad.mapping and a hint. */
export function mappingForGamepad(gp) {
  const m = (gp && gp.mapping) || "";
  if (m === "standard") return STANDARD_MAPPING;

  const id = (gp && gp.id || "").toLowerCase();

  // 8BitDo controllers in 2.4g/D-input mode
  if (/8bitdo|8bit.?do/i.test(id)) {
    return EIGHTBITDO_MAPPING;
  }

  // PlayStation controllers (DualShock, DualSense, etc.)
  if (/playstation|ps[345]|dualsense|dualshock|wireless controller/i.test(id)) {
    return PS_MAPPING;
  }

  // Xbox controllers always report standard, but if not, try standard anyway
  return STANDARD_MAPPING;
}

/** Convert a standard-shaped Gamepad buttons/axes snapshot to a libretro mask. */
export function standardGamepadToLibretro(buttons = [], axes = [], mapping = DEFAULT_GAMEPAD_MAPPING) {
  let state = 0;
  const pressed = (name) => {
    const idx = mapping[name];
    if (idx == null || idx >= buttons.length) return false;
    const btn = buttons[idx];
    return btn?.pressed ?? Boolean(btn);
  };
  const axis = (index) => Number.isFinite(axes[index]) ? axes[index] : 0;

  // ── D-pad: try buttons first, fall back to axes ──────────────
  const dpadUp    = pressed("dpadUp")    || axis(mapping.leftStickY) < -mapping.axisThreshold;
  const dpadDown  = pressed("dpadDown")  || axis(mapping.leftStickY) > mapping.axisThreshold;
  const dpadLeft  = pressed("dpadLeft")  || axis(mapping.leftStickX) < -mapping.axisThreshold;
  const dpadRight = pressed("dpadRight") || axis(mapping.leftStickX) > mapping.axisThreshold;

  // Also check dpadAxisX/dpadAxisY for non-standard PS controllers
  if (!dpadUp && !dpadDown && !dpadLeft && !dpadRight) {
    const dpax = mapping.dpadAxisX;
    const dpay = mapping.dpadAxisY;
    if (dpax != null && dpay != null) {
      const dx = axis(dpax);
      const dy = axis(dpay);
      if (dy < -0.5) state |= 1 << 4;   // Up
      if (dy > 0.5)  state |= 1 << 5;   // Down
      if (dx < -0.5) state |= 1 << 6;   // Left
      if (dx > 0.5)  state |= 1 << 7;   // Right
      // Don't short-circuit — still check face + shoulders below
    }
  }

  if (dpadUp)    state |= 1 << 4;
  if (dpadDown)  state |= 1 << 5;
  if (dpadLeft)  state |= 1 << 6;
  if (dpadRight) state |= 1 << 7;

  if (pressed("b"))      state |= 1 << 0;
  if (pressed("y"))      state |= 1 << 1;
  if (pressed("select")) state |= 1 << 2;
  if (pressed("start"))  state |= 1 << 3;
  if (pressed("a"))      state |= 1 << 8;
  if (pressed("x"))      state |= 1 << 9;
  if (pressed("l") || pressed("l1")) state |= 1 << 10;
  if (pressed("r") || pressed("r1")) state |= 1 << 11;

  return state;
}

/** Convert touch state to the same canonical standard-button representation. */
export function touchStateToStandardButtons(preset, state) {
  const buttons = new Array(16).fill(false);
  const dpad = state.dpad || [];
  const face = state.face || [];
  const system = state.system || [];

  for (let index = 0; index < 4; index++) buttons[12 + index] = Boolean(dpad[index]);
  if (preset === "genesis") {
    // Genesis A/B/C correspond to libretro Y/B/A positions.
    buttons[2] = Boolean(face[0]);
    buttons[0] = Boolean(face[1]);
    buttons[1] = Boolean(face[2]);
  } else if (preset === "psx") {
    // PSX ✕/○/□/△ → libretro B/A/Y/X positions
    buttons[0] = Boolean(face[0]);
    buttons[1] = Boolean(face[1]);
    buttons[2] = Boolean(face[2]);
    buttons[3] = Boolean(face[3]);
  } else {
    for (let index = 0; index < 4; index++) buttons[index] = Boolean(face[index]);
  }

  if (preset === "snes") {
    buttons[4] = Boolean(system[0]);
    buttons[8] = Boolean(system[1]);
    buttons[9] = Boolean(system[2]);
    buttons[5] = Boolean(system[3]);
  } else if (preset === "psx") {
    // PSX system: L1, R1, SELECT, START
    buttons[10] = Boolean(system[0]);
    buttons[11] = Boolean(system[1]);
    buttons[8] = Boolean(system[2]);
    buttons[9] = Boolean(system[3]);
  } else if (preset === "genesis" || preset === "gamegear") {
    // These presets expose START as their only system control.
    buttons[9] = Boolean(system[0]);
  } else {
    buttons[8] = Boolean(system[0]);
    buttons[9] = Boolean(system[1]);
  }
  return buttons;
}
