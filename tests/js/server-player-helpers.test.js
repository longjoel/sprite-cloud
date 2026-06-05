const test = require('node:test');
const assert = require('node:assert/strict');
const helpers = require('../../wwwroot/js/nosebleed-player/server-player-helpers.js');

test('chooseInitialGamepadIndex ignores disconnected stale browser gamepad slots', () => {
  const gamepads = [
    { index: 0, connected: false, id: 'Stale pad' },
    { index: 1, connected: true, id: 'Live pad' }
  ];

  const selected = helpers.chooseInitialGamepadIndex(gamepads, 0, 0);

  assert.equal(selected, 1);
});

test('chooseInitialGamepadIndex treats missing connected flag as usable for older browsers', () => {
  const gamepads = [
    { index: 0, id: 'Legacy pad without connected property' }
  ];

  const selected = helpers.chooseInitialGamepadIndex(gamepads, null, null);

  assert.equal(selected, 0);
});
