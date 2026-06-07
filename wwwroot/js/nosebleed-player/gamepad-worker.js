/**
 * Gamepad polling Web Worker.
 *
 * Runs gamepad state collection off the main thread at ~125 Hz,
 * posting snapshots back to the player page. Decouples input
 * polling from the main thread's rAF / rendering pipeline.
 *
 * Main-thread keyboard and touch-screen state is merged by the
 * player page after receiving a worker snapshot.
 *
 * @license MIT
 */

/* global self */

const POLL_INTERVAL_MS = 8; // ~125 Hz

/** Cached gamepad indices so we can detect connection changes. */
let knownIndices = new Set();

function pollGamepads() {
  const pads = self.navigator?.getGamepads?.() ?? [];
  const connected = [];
  const current = new Set();

  for (let i = 0; i < pads.length; i++) {
    const pad = pads[i];
    if (!pad || !pad.connected) continue;
    current.add(pad.index);

    connected.push({
      index: pad.index,
      id: pad.id,
      buttons: pad.buttons.map((b) => ({
        pressed: b.pressed,
        value: b.value,
      })),
      axes: Array.from(pad.axes),
    });
  }

  // Detect disconnects
  for (const idx of knownIndices) {
    if (!current.has(idx)) {
      self.postMessage({ type: 'gamepad-disconnected', index: idx });
    }
  }
  knownIndices = current;

  if (connected.length > 0) {
    self.postMessage({ type: 'gamepad-state', pads: connected });
  } else {
    // Still send a heartbeat so the main thread knows no gamepad is active
    self.postMessage({ type: 'gamepad-state', pads: [] });
  }
}

let timer = null;

self.addEventListener('message', (ev) => {
  if (ev.data?.type === 'start') {
    if (timer !== null) return;
    knownIndices = new Set();
    pollGamepads(); // immediate sample
    timer = self.setInterval(pollGamepads, POLL_INTERVAL_MS);
  } else if (ev.data?.type === 'stop') {
    if (timer !== null) {
      self.clearInterval(timer);
      timer = null;
    }
  }
});
