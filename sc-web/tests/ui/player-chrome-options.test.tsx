// @vitest-environment jsdom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import OptionsOverlay from "@/components/OptionsOverlay";

const playerSource = readFileSync("components/GamePlayer.tsx", "utf8");
const playerCss = readFileSync("components/GamePlayer.module.css", "utf8");
const optionsSource = readFileSync("components/OptionsOverlay.tsx", "utf8");
const optionsCss = readFileSync("components/OptionsOverlay.module.css", "utf8");
const remapSource = readFileSync("components/GamePlayerRemapPanel.tsx", "utf8");
const controllerPanelSource = readFileSync("components/ControllerLayoutPanel.tsx", "utf8");

describe("simplified player chrome", () => {
  it("uses the top chrome title as the sole persistent game identity", () => {
    expect(playerSource).toContain("styles.gameTitle");
    expect(playerSource).not.toContain("styles.gameInfo");
    expect(playerCss).not.toMatch(/\.gameInfo(?:Name|Badge)?\s*\{/);
  });

  it("gives every player action a visible text label", () => {
    expect(playerSource).not.toMatch(/>\s*✕\s*<\/button>/);
    expect(playerSource.match(/✕ Close/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
    expect(playerSource).toContain("↻ Retry");
    expect(remapSource).toContain("✕ Close");
    expect(controllerPanelSource).toContain("✕ Close");
  });

  it("wakes edge chrome for touch input and again when the player connects", () => {
    expect(playerSource).toContain("onPointerDown={wakeControls}");
    expect(playerSource).toMatch(/if \(state === "connected"\) \{[\s\S]*?wakeControls\(\)/);
  });

  it("keeps narrow portrait chrome compact while retaining text labels", () => {
    expect(playerSource).toContain("styles.audioLabelLong");
    expect(playerSource).toContain("styles.audioLabelCompact");
    expect(playerCss).toMatch(/\.gameTitle\s*\{[^}]*min-width:\s*0[^}]*text-overflow:\s*ellipsis/);
    expect(playerCss).toMatch(/@media\s*\(max-width:\s*480px\)[\s\S]*?\.audioLabelLong\s*\{[^}]*display:\s*none/);
    expect(playerCss).toMatch(/@media\s*\(max-width:\s*480px\)[\s\S]*?\.audioLabelCompact\s*\{[^}]*display:\s*inline/);
  });

  it("keeps only audio and options edge controls in the top bar during normal play (Back moved to OptionsOverlay)", () => {
    // Back should NOT be in the top bar chrome for normal connected play.
    // The ⋮ trigger belongs in the top bar alongside audio.
    expect(playerSource).toMatch(/styles\.topBar[\s\S]*?styles\.topBarActions[\s\S]*?audioMuted \? "Unmute audio" : "Mute audio"/);
    expect(playerSource).toContain('aria-label="Open options"');
    // The top bar action area must not contain ← Back (Back is now in OptionsOverlay).
    expect(playerSource).not.toMatch(/← Back/);
    expect(playerCss).toMatch(/\.topBar\s*\{[^}]*z-index:\s*12/);
  });

  it("places ← Library as first action in the Options overlay", () => {
    expect(optionsSource).toContain("← Library");
  });

  it("keeps ← Options navigation in sub-panels so players can return to Options", () => {
    expect(playerSource).toContain("← Options");
  });
});

describe("player option hierarchy", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  const renderOptions = async (withRoom = false) => {
    const actions = {
      save: vi.fn(), load: vi.fn(), fullscreen: vi.fn(), toggleControls: vi.fn(),
      controller: vi.fn(), keys: vi.fn(), saves: vi.fn(), share: vi.fn(),
      room: vi.fn(), stats: vi.fn(), restart: vi.fn(), close: vi.fn(),
    };
    await act(async () => {
      root.render(
        <OptionsOverlay
          visible
          onToggle={actions.close}
          onSave={actions.save}
          onLoad={actions.load}
          onFullscreen={actions.fullscreen}
          isFullscreen={false}
          controlsVisible
          onToggleControls={actions.toggleControls}
          onOpenController={actions.controller}
          onRestart={actions.restart}
          onOpenSaves={actions.saves}
          onOpenKeys={actions.keys}
          onOpenRoom={withRoom ? actions.room : undefined}
          onQrCode={actions.share}
          onStats={actions.stats}
        />,
      );
    });
    return actions;
  };

  const button = (label: string) => Array.from(host.querySelectorAll("button"))
    .find((item) => item.textContent?.includes(label));

  it("renders clear text-labelled groups without Snapshot or Cast", async () => {
    await renderOptions();

    expect(Array.from(host.querySelectorAll("section > h2")).map((heading) => heading.textContent))
      .toEqual(["Quick", "Input", "Session", "Diagnostics", "Danger"]);
    for (const label of [
      "Save", "Load", "Fullscreen", "Hide controls", "Controller Layout", "Keys",
      "Saves", "Share / QR", "Stats for Nerds", "Restart", "Close",
    ]) {
      expect(button(label), `${label} action`).toBeDefined();
    }
    expect(host.textContent).not.toContain("Snapshot");
    expect(host.textContent).not.toContain("Cast");
  });

  it("routes every option action to its existing callback", async () => {
    const actions = await renderOptions(true);
    for (const [label, action] of [
      ["Save", actions.save], ["Load", actions.load], ["Fullscreen", actions.fullscreen],
      ["Hide controls", actions.toggleControls], ["Controller Layout", actions.controller],
      ["Keys", actions.keys], ["Saves", actions.saves], ["Share / QR", actions.share],
      ["Room controls", actions.room], ["Stats for Nerds", actions.stats],
      ["Restart", actions.restart], ["Close", actions.close],
    ] as const) {
      await act(async () => button(label)!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
      expect(action, label).toHaveBeenCalledOnce();
    }
  });

  it("shows room controls only when the player marks them relevant", async () => {
    await renderOptions(false);
    expect(button("Room controls")).toBeUndefined();

    await renderOptions(true);
    expect(button("Room controls")).toBeDefined();
    expect(playerSource).toContain("roomControlsRelevant");
    expect(playerSource).toContain('roomControlsRelevant && overlayState.activePanel === "room"');
  });

  it("uses a safe-area scrolling mobile bottom sheet and compact desktop panel", () => {
    expect(optionsCss).toMatch(/\.panel\s*\{[\s\S]*?max-width:\s*min\(480px,\s*90vw\)/);
    expect(optionsCss).toMatch(/@media\s*\(max-width:\s*640px\)[\s\S]*\.backdrop\s*\{[^}]*align-items:\s*flex-end/);
    expect(optionsCss).toMatch(/@media\s*\(max-width:\s*640px\)[\s\S]*\.panel\s*\{[^}]*max-height:[^;}]*safe-area-inset-top[^}]*overflow-y:\s*auto[^}]*padding-bottom:[^;}]*safe-area-inset-bottom/);
    expect(optionsCss).toMatch(/@media\s*\(max-height:\s*520px\)\s*and\s*\(orientation:\s*landscape\)[\s\S]*?\.backdrop\s*\{[^}]*align-items:\s*flex-end/);
    expect(optionsCss).toMatch(/@media\s*\(max-height:\s*520px\)\s*and\s*\(orientation:\s*landscape\)[\s\S]*?\.panel\s*\{[^}]*max-height:[^;}]*safe-area-inset-top[^}]*overflow-y:\s*auto[^}]*padding-left:[^;}]*safe-area-inset-left[^}]*padding-right:[^;}]*safe-area-inset-right[^}]*padding-bottom:[^;}]*safe-area-inset-bottom/);
    expect(optionsCss).toMatch(/\.card,\s*\.closeButton\s*\{[^}]*min-height:\s*44px/);
    expect(playerCss).toMatch(/\.topBar button[\s\S]*?\.slotPanel button[\s\S]*?min-width:\s*44px[\s\S]*?min-height:\s*44px/);
  });

  it("renders room panel with proper header: Room, ← Options, and ✕ Close", () => {
    expect(playerSource).toContain("Room");
    expect(playerSource).toMatch(/Room[\s\S]*?← Options[\s\S]*?✕ Close/);
  });

  it("uses same bottom-sheet CSS pattern for room panel on mobile as OptionsOverlay", () => {
    // On mobile (<=640px), roomPanel must match OptionsOverlay's bottom-sheet patterns
    expect(playerCss).toMatch(/@media\s*\(max-width:\s*640px\)[\s\S]*?\.roomPanel\s*\{[\s\S]*?position:\s*fixed[\s\S]*?bottom:\s*0[\s\S]*?left:\s*0[\s\S]*?right:\s*0/);
    expect(playerCss).toMatch(/@media\s*\(max-width:\s*640px\)[\s\S]*?\.roomPanel\s*\{[\s\S]*?max-height:[\s\S]*?safe-area-inset-top[\s\S]*?overflow-y:\s*auto[\s\S]*?padding-bottom:[\s\S]*?safe-area-inset-bottom/);
    // Short landscape too
    expect(playerCss).toMatch(/@media\s*\(max-height:\s*520px\)\s*and\s*\(orientation:\s*landscape\)[\s\S]*?\.roomPanel\s*\{[\s\S]*?position:\s*fixed[\s\S]*?bottom:\s*0/);
  });
});
