const assert = require('node:assert/strict');
const helpers = require('../wwwroot/js/nosebleed-player/server-player-helpers.js');

assert.equal(
  helpers.nextAudioEnabledState(false),
  true,
  'audio toggle should enable audio from an off state'
);
assert.equal(
  helpers.nextAudioEnabledState(true),
  false,
  'audio toggle should mute/disable audio from an on state'
);

assert.deepEqual(
  helpers.calculateContainedSize(320, 240, 1000, 500),
  { width: 666.667, height: 500 },
  '4:3 video should be letterboxed inside a 2:1 container instead of stretched'
);
assert.deepEqual(
  helpers.calculateContainedSize(160, 144, 1000, 500),
  { width: 555.556, height: 500 },
  'Game Gear-ish video should preserve source aspect ratio in wide containers'
);
assert.deepEqual(
  helpers.calculateContainedSize(0, 0, 1000, 500),
  { width: 1000, height: 500 },
  'invalid source dimensions should safely use the container'
);

assert.equal(
  helpers.nextOverlayEnabledState(true),
  false,
  'overlay toggle should hide every overlay control/HUD for kiosk use'
);
assert.equal(
  helpers.nextOverlayEnabledState(false),
  true,
  'overlay toggle should restore overlays when needed'
);

const pads = [null, { index: 0, id: '8BitDo SN30' }];
assert.equal(
  helpers.chooseInitialGamepadIndex(pads, null),
  0,
  'an already-connected gamepad should be selected without requiring unplug/replug'
);
assert.equal(
  helpers.chooseInitialGamepadIndex(pads, 0),
  0,
  'a saved available gamepad index should be preserved'
);
assert.equal(
  helpers.chooseInitialGamepadIndex(pads, 4),
  0,
  'a stale saved gamepad index should fall back to the first connected pad'
);
assert.equal(
  helpers.chooseInitialGamepadIndex([], null),
  null,
  'no connected gamepad should leave selection unset'
);

const twoPads = [{ index: 0, id: 'P1 Pad' }, { index: 1, id: 'P2 Pad' }];
assert.equal(
  helpers.chooseInitialGamepadIndex(twoPads, null, 1),
  1,
  'player 2 should default to the second hardware gamepad instead of hijacking player 1 input'
);
assert.equal(
  helpers.chooseInitialGamepadIndex(twoPads, 0, 1),
  0,
  'an explicit per-seat saved selection should still be honored'
);

console.log('nosebleed server player helper tests passed');
