import { describe, expect, it } from "vitest";
import {
  backPlayerPanel,
  blockPlayerPanels,
  closePlayerPanel,
  INITIAL_PLAYER_OVERLAY_STATE,
  openPlayerPanel,
  type PlayerOverlayState,
} from "@/lib/ui/player-overlay-state";

describe("player overlay state", () => {
  it("starts with no active panel", () => {
    const state: PlayerOverlayState = INITIAL_PLAYER_OVERLAY_STATE;
    expect(state.activePanel).toBe("none");
  });

  it("models room and share as mutually exclusive player panels", () => {
    const room = openPlayerPanel(INITIAL_PLAYER_OVERLAY_STATE, "room");
    expect(openPlayerPanel(room, "share")).toEqual({ activePanel: "share" });
  });

  it("replaces the active panel when another panel opens", () => {
    const options = openPlayerPanel({ activePanel: "none" }, "options");
    const saves = openPlayerPanel(options, "saves");
    expect(saves).toEqual({ activePanel: "saves" });
  });

  it("closes the single active panel", () => {
    expect(closePlayerPanel({ activePanel: "stats" })).toEqual({ activePanel: "none" });
  });

  it.each(["saves", "stats", "keys", "room", "share", "controller"] as const)(
    "returns from the %s child panel to options",
    (activePanel) => {
      expect(backPlayerPanel({ activePanel })).toEqual({ activePanel: "options" });
    },
  );

  it("closes options when navigating back", () => {
    expect(backPlayerPanel({ activePanel: "options" })).toEqual({ activePanel: "none" });
  });

  it("leaves the no-panel state unchanged so the player can navigate away", () => {
    expect(backPlayerPanel({ activePanel: "none" })).toEqual({ activePanel: "none" });
  });

  it("clears a child panel when a higher-priority blocker activates", () => {
    expect(blockPlayerPanels({ activePanel: "keys" })).toEqual({ activePanel: "none" });
  });
});
