// @vitest-environment jsdom
/**
 * Regression: ICE gathering must not block match start on a slow or
 * unreachable TURN allocation. With TURN configured, browsers stay in
 * "gathering" until the relay allocation resolves; the player previously
 * waited the full 15s timeout, then sent a partial offer. Now it exits
 * as soon as a usable candidate (srflx/relay, or host after 1500ms) is
 * in the SDP.
 */
import { describe, expect, it } from "vitest";
import { ScPlayer, State } from "../../public/player/sc-player.js";

/** Build a minimal fake PC whose localDescription SDP we control. */
function makeFakePc(sdp: string, gatheringState = "gathering") {
  return {
    iceGatheringState: gatheringState,
    localDescription: { sdp },
  } as any;
}

/** A minimal fake <video> element satisfying ScPlayer's constructor. */
function makeFakeVideo() {
  return document.createElement("video");
}

/** Call the real method on a minimally-shaped ScPlayer instance. */
async function runWait(fakePc: any, overrides: Record<string, any> = {}) {
  const player = new ScPlayer(makeFakeVideo(), {
    iceServers: [],
    iceTimeout: 15000,
  }) as any;
  Object.assign(player, overrides);
  player._pc = fakePc;
  const start = Date.now();
  await player._waitForIceGatheringComplete();
  return Date.now() - start;
}

describe("_waitForIceGatheringComplete TURN-aware early exit", () => {
  it("exits immediately when SDP has an srflx candidate (never waits for relay)", async () => {
    const fakePc = makeFakePc(
      "v=0\r\na=candidate:1 1 UDP 2122252543 1.2.3.4 5678 typ srflx raddr 0.0.0.0 rport 0\r\n",
    );
    const elapsed = await runWait(fakePc);
    expect(elapsed).toBeLessThan(2000);
  });

  it("exits immediately when SDP has a relay candidate", async () => {
    const fakePc = makeFakePc(
      "v=0\r\na=candidate:1 1 UDP 2122252543 5.6.7.8 12345 typ relay\r\n",
    );
    const elapsed = await runWait(fakePc);
    expect(elapsed).toBeLessThan(2000);
  });

  it("exits on host candidate after the 1500ms same-LAN grace (not full timeout)", async () => {
    const fakePc = makeFakePc(
      "v=0\r\na=candidate:1 1 UDP 2122252543 192.168.1.5 5678 typ host\r\n",
    );
    const elapsed = await runWait(fakePc);
    expect(elapsed).toBeGreaterThanOrEqual(1400);
    expect(elapsed).toBeLessThan(4000);
  });

  it("still waits when SDP has no candidates at all", async () => {
    const fakePc = makeFakePc("v=0\r\n");
    const elapsed = await runWait(fakePc);
    // No usable candidate → the 15s timeout still applies (fake PC never
    // completes, so we hit the full timeout).
    expect(elapsed).toBeGreaterThanOrEqual(14000);
  });

  it("LAN-direct path still exits on first host candidate", async () => {
    const fakePc = makeFakePc(
      "v=0\r\na=candidate:1 1 UDP 2122252543 192.168.1.5 5678 typ host\r\n",
    );
    // window.location is jsdom's http://localhost:3000 — not LAN-direct,
    // so force the LAN branch via the route=lan query param.
    const originalSearch = window.location.search;
    // The function reads window.location.search; jsdom allows overriding.
    Object.defineProperty(window, "location", {
      value: { ...window.location, search: "?route=lan" },
      writable: true,
    });
    const elapsed = await runWait(fakePc);
    expect(elapsed).toBeLessThan(1000);
    Object.defineProperty(window, "location", {
      value: { ...window.location, search: originalSearch },
      writable: true,
    });
  });
});
