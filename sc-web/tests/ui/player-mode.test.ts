import { describe, expect, it } from "vitest";
import { resolveControlsEnabled } from "@/lib/ui/player-mode";

describe("resolveControlsEnabled", () => {
  it("hides on-screen controls in the non-immersive Room view regardless of user toggle", () => {
    expect(resolveControlsEnabled(false, true)).toBe(false);
    expect(resolveControlsEnabled(false, false)).toBe(false);
  });

  it("shows controls only when immersive and the user has not turned them off", () => {
    expect(resolveControlsEnabled(true, true)).toBe(true);
  });

  it("lets a user disable controls while immersive", () => {
    expect(resolveControlsEnabled(true, false)).toBe(false);
  });
});