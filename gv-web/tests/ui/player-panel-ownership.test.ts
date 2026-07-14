import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const playerSource = readFileSync(new URL("../../components/GamePlayer.tsx", import.meta.url), "utf8");
const optionsSource = readFileSync(new URL("../../components/OptionsOverlay.tsx", import.meta.url), "utf8");

describe("GamePlayer panel ownership", () => {
  it("uses one active panel instead of independent panel visibility booleans", () => {
    expect(playerSource).toContain("const [overlayState, setOverlayState]");
    expect(playerSource).toContain("activePanel");
    for (const zombie of ["showOptions", "showStats", "showSlots", "showRoomControls", "showRemap", "showQr"]) {
      expect(playerSource).not.toContain(zombie);
    }
  });

  it("clears touch input, handles Escape, and restores the options trigger", () => {
    expect(playerSource).toContain("tg.hide()");
    expect(playerSource).toContain('event.key !== "Escape"');
    expect(playerSource).toContain("optionsTriggerRef.current?.focus()");
  });

  it("marks active panels as modal focus scopes", () => {
    expect(playerSource).toContain('role="dialog"');
    expect(playerSource).toContain('aria-modal="true"');
    expect(playerSource).toContain("trapPanelFocus");
    expect(optionsSource).toContain('role="dialog"');
    expect(optionsSource).toContain('aria-modal="true"');
  });

  it("always renders the active Share panel while its code is being prepared", () => {
    expect(playerSource).toContain('overlayState.activePanel === "share" && (');
    expect(playerSource).not.toContain('overlayState.activePanel === "share" && shortCode');
    expect(playerSource).toContain("Preparing share code…");
  });

  it("routes panel dismissal through closePanel so focus is restored to the options trigger", () => {
    expect(playerSource).toContain("closePanel();");
  });

  it("keeps child-to-Options navigation reachable inside every child focus scope", () => {
    expect(playerSource.match(/>← Options<\/Button>/g)).toHaveLength(4);
    expect(playerSource).toContain('onBack={() => openPanel("options")}');
    expect(optionsSource).toContain('label: "Room controls", action: onOpenRoom');
  });
});
