const assert = require('node:assert/strict');
const input = require('../wwwroot/js/nosebleed-player/input-helpers.js');

const padRect = { left: 0, top: 0, width: 90, height: 90 };

function buttonsAt(clientX, clientY) {
  return input.resolveDpadButtonsFromPoint(padRect, clientX, clientY).sort();
}

assert.deepEqual(buttonsAt(45, 5), ['up'], 'top center should press up');
assert.deepEqual(buttonsAt(85, 5), ['right', 'up'], 'top-right corner should press up+right diagonal');
assert.deepEqual(buttonsAt(5, 85), ['down', 'left'], 'bottom-left corner should press down+left diagonal');
assert.deepEqual(buttonsAt(45, 45), [], 'center dead zone should release d-pad directions');
assert.deepEqual(buttonsAt(85, 45), ['right'], 'right edge center should press right only');

console.log('nosebleed input helper tests passed');
