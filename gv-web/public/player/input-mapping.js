// Canonical browser Gamepad API → libretro joypad mapping.
// Standard face positions are bottom, right, left, top; for SNES those are B, A, Y, X.

export const GAMEPAD_MASK = Object.freeze(
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]
    .reduce((mask, bit) => mask | (1 << bit), 0),
);

export const DEFAULT_GAMEPAD_MAPPING = Object.freeze({
  dpadUp: 12,
  dpadDown: 13,
  dpadLeft: 14,
  dpadRight: 15,
  start: 9,
  select: 8,
  b: 0,
  a: 1,
  y: 2,
  x: 3,
  l: 4,
  r: 5,
  leftStickX: 0,
  leftStickY: 1,
  axisThreshold: 0.5,
});

/** Convert a standard-shaped Gamepad buttons/axes snapshot to a libretro mask. */
export function standardGamepadToLibretro(buttons = [], axes = [], mapping = DEFAULT_GAMEPAD_MAPPING) {
  let state = 0;
  const pressed = (name) => buttons[mapping[name]]?.pressed ?? Boolean(buttons[mapping[name]]);
  const axis = (index) => Number.isFinite(axes[index]) ? axes[index] : 0;

  if (pressed("b")) state |= 1 << 0;
  if (pressed("y")) state |= 1 << 1;
  if (pressed("select")) state |= 1 << 2;
  if (pressed("start")) state |= 1 << 3;
  if (pressed("dpadUp") || axis(mapping.leftStickY) < -mapping.axisThreshold) state |= 1 << 4;
  if (pressed("dpadDown") || axis(mapping.leftStickY) > mapping.axisThreshold) state |= 1 << 5;
  if (pressed("dpadLeft") || axis(mapping.leftStickX) < -mapping.axisThreshold) state |= 1 << 6;
  if (pressed("dpadRight") || axis(mapping.leftStickX) > mapping.axisThreshold) state |= 1 << 7;
  if (pressed("a")) state |= 1 << 8;
  if (pressed("x")) state |= 1 << 9;
  if (pressed("l")) state |= 1 << 10;
  if (pressed("r")) state |= 1 << 11;
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
  } else {
    for (let index = 0; index < 4; index++) buttons[index] = Boolean(face[index]);
  }

  if (preset === "snes") {
    buttons[4] = Boolean(system[0]);
    buttons[8] = Boolean(system[1]);
    buttons[9] = Boolean(system[2]);
    buttons[5] = Boolean(system[3]);
  } else if (preset === "genesis" || preset === "gamegear") {
    // These presets expose START as their only system control.
    buttons[9] = Boolean(system[0]);
  } else {
    buttons[8] = Boolean(system[0]);
    buttons[9] = Boolean(system[1]);
  }
  return buttons;
}
