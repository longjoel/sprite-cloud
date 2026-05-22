const assert = require('node:assert/strict');
const preview = require('../wwwroot/js/nosebleed-player/preview.js');

assert.equal(
  preview.buildVideoWebSocketUrl('http://vault.local/Home/NosebleedPreviewVideo?sessionId=session-1'),
  'ws://vault.local/Home/NosebleedPreviewVideo?sessionId=session-1'
);

assert.equal(
  preview.buildVideoWebSocketUrl('https://vault.example/Home/NosebleedPreviewVideo?sessionId=session-1'),
  'wss://vault.example/Home/NosebleedPreviewVideo?sessionId=session-1'
);

assert.equal(preview.buildVideoWebSocketUrl('', 'x'), null);

function makeNbf0BgraFrame() {
  const width = 2;
  const height = 1;
  const pitch = 8;
  const payloadLen = 8;
  const payloadOffset = 37;
  const buffer = new ArrayBuffer(payloadOffset + payloadLen);
  const view = new DataView(buffer);
  for (const [index, char] of Array.from('NBF0').entries()) {
    view.setUint8(index, char.charCodeAt(0));
  }
  view.setUint32(20, width, true);
  view.setUint32(24, height, true);
  view.setUint32(28, pitch, true);
  view.setUint8(32, 0); // BGRA8888, the normal server-player path.
  view.setUint32(33, payloadLen, true);

  const pixels = new Uint8Array(buffer, payloadOffset, payloadLen);
  pixels.set([
    1, 2, 3, 255,      // B,G,R,A -> R,G,B,A = 3,2,1,255
    10, 20, 30, 255,   // B,G,R,A -> R,G,B,A = 30,20,10,255
  ]);
  return buffer;
}

function fakeCanvas() {
  const calls = [];
  return {
    width: 0,
    height: 0,
    calls,
    getContext() {
      return {
        createImageData(width, height) {
          return { width, height, data: new Uint8ClampedArray(width * height * 4) };
        },
        putImageData(image, x, y) {
          calls.push({ image, x, y });
        },
      };
    },
  };
}

const canvas = fakeCanvas();
assert.equal(preview.renderFrame(canvas, makeNbf0BgraFrame()), true);
assert.equal(canvas.width, 2);
assert.equal(canvas.height, 1);
assert.equal(canvas.calls.length, 1);
assert.deepEqual(Array.from(canvas.calls[0].image.data), [3, 2, 1, 255, 30, 20, 10, 255]);

const oldPreviewFrame = new ArrayBuffer(30);
const oldView = new DataView(oldPreviewFrame);
for (const [index, char] of Array.from('NBV0').entries()) {
  oldView.setUint8(index, char.charCodeAt(0));
}
assert.equal(preview.renderFrame(fakeCanvas(), oldPreviewFrame), false);

console.log('nosebleed preview helper tests passed');
