const test = require('node:test');
const assert = require('node:assert/strict');
const preview = require('../../wwwroot/js/nosebleed-player/preview.js');

function createCanvasStub() {
  const state = {
    putImageDataCalls: 0,
    drawImageCalls: 0,
    lastImageData: null,
    lastDrawImageArgs: null
  };

  const ctx = {
    createImageData(width, height) {
      return {
        width,
        height,
        data: new Uint8ClampedArray(width * height * 4)
      };
    },
    putImageData(image, x, y) {
      state.putImageDataCalls += 1;
      state.lastImageData = image;
      state.lastPutImageDataArgs = [x, y];
    },
    drawImage(...args) {
      state.drawImageCalls += 1;
      state.lastDrawImageArgs = args;
    }
  };

  return {
    width: 0,
    height: 0,
    getContext() {
      return ctx;
    },
    state
  };
}

function buildRawFramePacket() {
  const width = 1;
  const height = 1;
  const pitch = 4;
  const payload = Uint8Array.from([0x00, 0x00, 0xff, 0xff]); // BGRA red pixel
  const packet = new Uint8Array(37 + payload.length);
  const view = new DataView(packet.buffer);
  packet.set(Buffer.from('NBF0'), 0);
  view.setUint32(20, width, true);
  view.setUint32(24, height, true);
  view.setUint32(28, pitch, true);
  view.setUint8(32, 0);
  view.setUint32(33, payload.length, true);
  packet.set(payload, 37);
  return packet.buffer;
}

function buildJpegPacket() {
  const jpegBytes = Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]);
  const packet = new Uint8Array(16 + jpegBytes.length);
  const view = new DataView(packet.buffer);
  packet.set(Buffer.from('NBJ0'), 0);
  view.setUint32(4, 2, true);
  view.setUint32(8, 3, true);
  view.setUint32(12, jpegBytes.length, true);
  packet.set(jpegBytes, 16);
  return packet.buffer;
}

test('renderFrame draws raw NBF0 frame payloads to the preview canvas', () => {
  const canvas = createCanvasStub();
  const rendered = preview.renderFrame(canvas, buildRawFramePacket());

  assert.equal(rendered, true);
  assert.equal(canvas.width, 1);
  assert.equal(canvas.height, 1);
  assert.equal(canvas.state.putImageDataCalls, 1);
  assert.equal(canvas.state.lastImageData.data[0], 255);
  assert.equal(canvas.state.lastImageData.data[1], 0);
  assert.equal(canvas.state.lastImageData.data[2], 0);
  assert.equal(canvas.state.lastImageData.data[3], 255);
});

test('renderFrame draws JPEG NBJ0 preview packets to the preview canvas', async () => {
  const canvas = createCanvasStub();
  const originalCreateImageBitmap = global.createImageBitmap;
  const originalBlob = global.Blob;

  class FakeBlob {
    constructor(parts, options = {}) {
      this.parts = parts;
      this.type = options.type;
    }
  }

  let bitmapClosed = false;
  global.Blob = FakeBlob;
  global.createImageBitmap = async blob => ({
    blob,
    close() {
      bitmapClosed = true;
    }
  });

  try {
    const rendered = preview.renderFrame(canvas, buildJpegPacket());
    await new Promise(resolve => setImmediate(resolve));

    assert.equal(rendered, true);
    assert.equal(canvas.width, 2);
    assert.equal(canvas.height, 3);
    assert.equal(canvas.state.drawImageCalls, 1);
    assert.equal(canvas.state.lastDrawImageArgs[1], 0);
    assert.equal(canvas.state.lastDrawImageArgs[2], 0);
    assert.equal(canvas.state.lastDrawImageArgs[3], 2);
    assert.equal(canvas.state.lastDrawImageArgs[4], 3);
    assert.equal(bitmapClosed, true);
  } finally {
    global.createImageBitmap = originalCreateImageBitmap;
    global.Blob = originalBlob;
  }
});
