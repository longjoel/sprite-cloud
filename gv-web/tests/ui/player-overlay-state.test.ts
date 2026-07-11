import { describe, expect, it } from "vitest";
import {
  closePlayerPanel,
  openPlayerPanel,
  type PlayerOverlayState,
} from "@/lib/ui/player-overlay-state";

describe("player overlay state", () => {
  it("starts with no active panel", () => {
    const state: PlayerOverlayState = { activePanel: "none" };
    expect(state.activePanel).toBe("none");
  });

  it("replaces the active panel when another panel opens", () => {
    const options = openPlayerPanel({ activePanel: "none" }, "options");
    const saves = openPlayerPanel(options, "saves");
    expect(saves).toEqual({ activePanel: "saves" });
  });

  it("closes the single active panel", () => {
    expect(closePlayerPanel({ activePanel: "stats" })).toEqual({ activePanel: "none" });
  });
});
