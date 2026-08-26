import { describe, expect, it } from "vitest";

let clock = 0;
const now = () => clock;

import { DoubleTapDetector } from "@/lib/ui/double-tap";

const up = (x: number, y: number, interactive = false) => ({ x, y, interactive });

function newDetector(onDoubleTap = () => {}) {
  const detector = new DoubleTapDetector({ onDoubleTap, now });
  // deterministic start: first tap at t=1000
  clock = 1000;
  return detector;
}

describe("DoubleTapDetector", () => {
  it("fires on two pointer-ups within the interval and slop", () => {
    let fired = 0;
    const d = newDetector(() => fired++);
    d.handlePointerUp(up(0, 0));
    clock += 150;
    d.handlePointerUp(up(10, 10));
    expect(fired).toBe(1);
  });

  it("does not fire when the second tap is too slow", () => {
    let fired = 0;
    const d = newDetector(() => fired++);
    d.handlePointerUp(up(0, 0));
    clock += 600; // beyond default 300ms interval
    d.handlePointerUp(up(10, 10));
    expect(fired).toBe(0);
  });

  it("does not fire when the second tap drifts beyond the slop", () => {
    let fired = 0;
    const d = newDetector(() => fired++);
    d.handlePointerUp(up(0, 0));
    clock += 100;
    d.handlePointerUp(up(200, 200)); // ~283px away, beyond default 60px slop
    expect(fired).toBe(0);
  });

  it("a quick triple-tap fires exactly once", () => {
    let fired = 0;
    const d = newDetector(() => fired++);
    d.handlePointerUp(up(0, 0));
    clock += 100;
    d.handlePointerUp(up(5, 5)); // fires, resets
    clock += 100;
    d.handlePointerUp(up(8, 8)); // only a fresh single tap now
    expect(fired).toBe(1);
  });

  it("an interactive tap clears the pending first tap without firing", () => {
    let fired = 0;
    const d = newDetector(() => fired++);
    d.handlePointerUp(up(0, 0)); // pending single tap
    clock += 100;
    d.handlePointerUp(up(4, 4, true)); // landed on a button/control -> clears
    clock += 100;
    d.handlePointerUp(up(6, 6)); // fresh single tap, no pair
    expect(fired).toBe(0);
  });

  it("reset() clears a pending first tap so the next tap is treated as fresh", () => {
    let fired = 0;
    const d = newDetector(() => fired++);
    d.handlePointerUp(up(0, 0));
    d.reset();
    clock += 100;
    d.handlePointerUp(up(4, 4));
    expect(fired).toBe(0);
  });

  it("fires once even when the space between two taps lands on an ignored control", () => {
    // note: interactive clears on that pointer-up, but the recognizer is fed
    // only non-interactive samples from the stage; this documents the contract.
    let fired = 0;
    const d = newDetector(() => fired++);
    d.handlePointerUp(up(0, 0));
    clock += 120;
    d.handlePointerUp(up(6, 6));
    clock += 120;
    d.handlePointerUp(up(10, 10, true)); // control press after double-tap
    expect(fired).toBe(1);
  });
});