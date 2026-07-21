// sc-player tests — unit and integration.
//
// Unit tests use linkedom for DOM simulation; no browser required.
// Integration tests require a running host runtime (set GV_WORKER_URL for compatibility).
//
// Run: node --test tests/player.test.js

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { parseHTML } from "linkedom";

// ---------------------------------------------------------------------------
// DOM polyfill — must run before importing ScPlayer
// ---------------------------------------------------------------------------

function setupDOM() {
  const { window } = parseHTML("<!doctype html><html><body></body></html>");
  const { document } = window;

  // Expose DOM globals for ScPlayer and tests
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

// Must be called before importing ScPlayer
setupDOM();

const { ScPlayer, State, classifyRoute } = await import("../index.js");

// ---------------------------------------------------------------------------
// Unit: construction
// ---------------------------------------------------------------------------

describe("ScPlayer construction", () => {
  it("requires a <video> element", () => {
    assert.throws(() => new ScPlayer(null), TypeError);
    assert.throws(() => new ScPlayer({}), TypeError);
    assert.throws(() => new ScPlayer("not-an-element"), TypeError);
  });

  it("sets video element attributes", () => {
    const video = document.createElement("video");
    const player = new ScPlayer(video);
    assert.equal(video.autoplay, true);
    assert.equal(video.playsinline, true);
    assert.equal(player.state, State.IDLE);
  });
});

// ---------------------------------------------------------------------------
// Unit: state machine
// ---------------------------------------------------------------------------

describe("ScPlayer state machine", () => {
  let player, states;

  before(() => {
    const video = document.createElement("video");
    player = new ScPlayer(video);
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

describe("ScPlayer callback safety", () => {
  it("throwing onStateChange does not throw out of disconnect", () => {
    const video = document.createElement("video");
    const player = new ScPlayer(video);
    player.onStateChange = () => {
      throw new Error("boom");
    };
    assert.doesNotThrow(() => player.disconnect());
    assert.equal(player.state, State.IDLE);
  });

  it("duplicate state transitions are suppressed", () => {
    const video = document.createElement("video");
    const player = new ScPlayer(video);
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
// Unit: route classification
// ---------------------------------------------------------------------------

describe("classifyRoute", () => {
  it("classifies host/host as local", () => {
    const result = classifyRoute(
      { localCandidateType: "host", remoteCandidateType: "host" },
      "connected"
    );
    assert.equal(result.route, "local");
    assert.equal(result.detail, "LAN host");
  });

  it("classifies srflx/host as direct", () => {
    const result = classifyRoute(
      { localCandidateType: "srflx", remoteCandidateType: "host" },
      "connected"
    );
    assert.equal(result.route, "direct");
    assert.equal(result.detail, "STUN direct");
  });

  it("classifies relay on either side as relay", () => {
    const result = classifyRoute(
      { localCandidateType: "host", remoteCandidateType: "relay" },
      "connected"
    );
    assert.equal(result.route, "relay");
    assert.equal(result.detail, "TURN relay");
  });

  it("classifies ICE failed state as failed", () => {
    const result = classifyRoute(
      { localCandidateType: "host", remoteCandidateType: "host" },
      "failed"
    );
    assert.equal(result.route, "failed");
    assert.equal(result.detail, "ICE failed");
  });

  it("classifies missing stats as unknown", () => {
    const result = classifyRoute(null, "connected");
    assert.equal(result.route, "unknown");
    assert.equal(result.detail, "no candidate stats");
  });

  it("classifies empty candidate types as unknown", () => {
    const result = classifyRoute(
      { localCandidateType: "", remoteCandidateType: "" },
      "connected"
    );
    assert.equal(result.route, "unknown");
    assert.equal(result.detail, "no candidate stats");
  });
});


// ---------------------------------------------------------------------------
// Integration: requires GV_WORKER_URL env var
// ---------------------------------------------------------------------------

describe("ScPlayer integration", { skip: !process.env.GV_WORKER_URL }, () => {
  let player;

  before(() => {
    const video = document.createElement("video");
    player = new ScPlayer(video);
  });

  after(() => {
    player.disconnect();
  });

  it("connects and receives video from the host runtime", async () => {
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
