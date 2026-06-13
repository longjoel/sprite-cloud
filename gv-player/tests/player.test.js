// gv-player tests — unit and integration.
//
// Unit tests use linkedom for DOM simulation; no browser required.
// Integration tests require a running gv-worker (set GV_WORKER_URL).
//
// Run: node --test tests/player.test.js

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { parseHTML } from "linkedom";

// ---------------------------------------------------------------------------
// DOM polyfill — must run before importing GvPlayer
// ---------------------------------------------------------------------------

function setupDOM() {
  const { window } = parseHTML("<!doctype html><html><body></body></html>");
  const { document } = window;

  // Expose DOM globals for GvPlayer and tests
  globalThis.document = document;
  globalThis.HTMLVideoElement = window.HTMLVideoElement;

  // Stub WebRTC APIs (not available in Node)
  if (!globalThis.RTCPeerConnection) {
    globalThis.RTCPeerConnection = class {
      constructor() {}
      close() {}
    };
  }
  if (!globalThis.RTCSessionDescription) {
    globalThis.RTCSessionDescription = class {};
  }
  if (!globalThis.MediaStream) {
    globalThis.MediaStream = class {
      constructor(tracks) { this._tracks = tracks || []; }
      getTracks() { return this._tracks; }
    };
  }
  if (!globalThis.MediaStreamTrack) {
    globalThis.MediaStreamTrack = class {
      constructor() { this.kind = "video"; }
    };
  }
  if (!globalThis.fetch) {
    globalThis.fetch = async () => {
      throw new Error("fetch not mocked — use unit tests for offline logic");
    };
  }
  return document;
}

// Must be called before importing GvPlayer
setupDOM();

const { GvPlayer, State } = await import("../index.js");

// ---------------------------------------------------------------------------
// Unit: construction
// ---------------------------------------------------------------------------

describe("GvPlayer construction", () => {
  it("requires a <video> element", () => {
    assert.throws(() => new GvPlayer(null), TypeError);
    assert.throws(() => new GvPlayer({}), TypeError);
    assert.throws(() => new GvPlayer("not-an-element"), TypeError);
  });

  it("sets video element attributes", () => {
    const video = document.createElement("video");
    const player = new GvPlayer(video);
    assert.equal(video.autoplay, true);
    assert.equal(video.playsinline, true);
    assert.equal(video.muted, true);
    assert.equal(player.state, State.IDLE);
  });
});

// ---------------------------------------------------------------------------
// Unit: state machine
// ---------------------------------------------------------------------------

describe("GvPlayer state machine", () => {
  let player, states;

  before(() => {
    const video = document.createElement("video");
    player = new GvPlayer(video);
    states = [];
    player.onStateChange = (state, detail) => {
      states.push({ state, detail });
    };
  });

  after(() => {
    player.disconnect();
  });

  it("starts idle", () => {
    assert.equal(player.state, State.IDLE);
  });

  it("disconnect from idle is a no-op", () => {
    player.disconnect();
    assert.equal(player.state, State.IDLE);
    assert.equal(states.length, 0);
  });

  it("disconnect does not override error state", () => {
    player._setState(State.ERROR, "test error");
    assert.equal(player.state, State.ERROR);
    player.disconnect();
    assert.equal(player.state, State.ERROR);
  });
});

// ---------------------------------------------------------------------------
// Unit: callback safety
// ---------------------------------------------------------------------------

describe("GvPlayer callback safety", () => {
  it("throwing onStateChange does not throw out of disconnect", () => {
    const video = document.createElement("video");
    const player = new GvPlayer(video);
    player.onStateChange = () => {
      throw new Error("boom");
    };
    assert.doesNotThrow(() => player.disconnect());
    assert.equal(player.state, State.IDLE);
  });

  it("duplicate state transitions are suppressed", () => {
    const video = document.createElement("video");
    const player = new GvPlayer(video);
    let callCount = 0;
    player.onStateChange = () => {
      callCount++;
    };
    player._setState(State.CONNECTED);
    player._setState(State.CONNECTED);
    assert.equal(callCount, 1);
  });
});

// ---------------------------------------------------------------------------
// Integration: requires GV_WORKER_URL env var
// ---------------------------------------------------------------------------

describe("GvPlayer integration", { skip: !process.env.GV_WORKER_URL }, () => {
  let player;

  before(() => {
    const video = document.createElement("video");
    player = new GvPlayer(video);
  });

  after(() => {
    player.disconnect();
  });

  it("connects and receives video from gv-worker", async () => {
    const workerUrl = process.env.GV_WORKER_URL;

    const trackPromise = new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("no track within 10s")),
        10000,
      );
      player.onTrack = (track) => {
        clearTimeout(timeout);
        resolve(track);
      };
      player.onStateChange = (state, detail) => {
        if (state === State.ERROR) reject(new Error(detail));
      };
    });

    await player.connect(workerUrl);
    const track = await trackPromise;

    assert.equal(track.kind, "video");
    assert.equal(player.state, State.CONNECTED);
  });
});
