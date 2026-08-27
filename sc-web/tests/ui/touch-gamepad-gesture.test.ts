import { describe, expect, it } from "vitest";
import { hitTestEditBody, nearestResizeGrip } from "../../lib/touch-gamepad/index";

// A minimal TouchGamepad-shaped object for the pure edit-gesture helpers (no
// canvas/DOM needed — these only read geometry).
const gp = {
  _dpad: { x: 0.1, y: 0.6, w: 0.3, h: 0.2 },
  _face: [{ x: 0.6, y: 0.1, w: 0.2, h: 0.15 }],
  _system: [{ x: 0.1, y: 0.1, w: 0.15, h: 0.1 }],
};

describe("hitTestEditBody", () => {
  it("hits a face button body", () => {
    expect(hitTestEditBody(gp as never, { x: 0.65, y: 0.15 })).toEqual({ kind: "face", index: 0 });
  });

  it("hits a system button body", () => {
    expect(hitTestEditBody(gp as never, { x: 0.15, y: 0.13 })).toEqual({ kind: "system", index: 0 });
  });

  it("reports the dpad bounding box (routed to the legacy path, not the gesture)", () => {
    expect(hitTestEditBody(gp as never, { x: 0.2, y: 0.7 })).toEqual({ kind: "dpad", index: -1 });
  });

  it("returns null for a miss", () => {
    expect(hitTestEditBody(gp as never, { x: 0.5, y: 0.5 })).toBeNull();
  });
});

describe("nearestResizeGrip", () => {
  // Button spans x:[0.5,0.7] y:[0.5,0.6] => corners nw=(0.5,0.5) ne=(0.7,0.5)
  // sw=(0.5,0.6) se=(0.7,0.6).
  const tgt = { x: 0.5, y: 0.5, w: 0.2, h: 0.1 };

  it("grips the south-east corner when pressed near it", () => {
    expect(nearestResizeGrip(tgt, { x: 0.69, y: 0.59 }, 0.01, 0.01).tag).toBe("se");
  });

  it("grips the north-west corner when pressed near it", () => {
    expect(nearestResizeGrip(tgt, { x: 0.51, y: 0.51 }, -0.01, -0.01).tag).toBe("nw");
  });

  it("grips the north-east corner when pressed near it", () => {
    expect(nearestResizeGrip(tgt, { x: 0.69, y: 0.51 }, 0.01, -0.01).tag).toBe("ne");
  });

  it("grips the south-west corner when pressed near it", () => {
    expect(nearestResizeGrip(tgt, { x: 0.51, y: 0.59 }, -0.01, 0.01).tag).toBe("sw");
  });

  it("uses drag direction to resolve a dead-centre press (down-right → se)", () => {
    // x:[0.5,0.7] centre x=0.6 (±0.05 dead-zone); y:[0.5,0.6] centre y=0.55 (±0.025).
    expect(nearestResizeGrip(tgt, { x: 0.6, y: 0.55 }, 0.01, 0.01).tag).toBe("se");
  });

  it("uses drag direction to resolve a dead-centre press (up-left → nw)", () => {
    expect(nearestResizeGrip(tgt, { x: 0.6, y: 0.55 }, -0.01, -0.01).tag).toBe("nw");
  });
});