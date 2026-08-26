// @vitest-environment jsdom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import PreImmersiveHint from "@/components/PreImmersiveHint";

function stubGetGamepads(pads: (Gamepad | null)[]) {
  Object.defineProperty(navigator, "getGamepads", {
    value: () => pads,
    configurable: true,
  });
}

describe("PreImmersiveHint", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    document.body.replaceChildren();
    vi.restoreAllMocks();
    vi.useRealTimers();
    delete (navigator as unknown as { getGamepads?: unknown }).getGamepads;
  });

  const renderHint = (open: boolean, onDismiss: () => void) =>
    act(async () => {
      root.render(<PreImmersiveHint open={open} onDismiss={onDismiss} />);
    });

  it("renders nothing when closed", async () => {
    stubGetGamepads([null, null]);
    await renderHint(false, vi.fn());
    expect(host.textContent).toBe("");
  });

  it("shows the double-tap CTA and the plug-in-your-gamepad line when no gamepad is connected", async () => {
    stubGetGamepads([null, null]);
    await renderHint(true, vi.fn());
    expect(host.textContent).toContain("Double-tap to play");
    expect(host.textContent).toContain("Plug in your gamepad now, then double-tap.");
  });

  it("omits the plug-in line when a gamepad is already connected", async () => {
    stubGetGamepads([{ connected: true } as unknown as Gamepad]);
    await renderHint(true, vi.fn());
    expect(host.textContent).toContain("Double-tap to play");
    expect(host.textContent).not.toContain("Plug in your gamepad");
  });

  it("auto-dismisses when a gamepad connects while the hint is open", async () => {
    stubGetGamepads([null, null]);
    const onDismiss = vi.fn();
    await renderHint(true, onDismiss);
    await act(async () => {
      window.dispatchEvent(new Event("gamepadconnected"));
    });
    expect(onDismiss).toHaveBeenCalledTimes(1);
    // And the gamepad reminder no longer renders.
    expect(host.textContent).not.toContain("Plug in your gamepad");
  });

  it("dismisses via the dismiss button", async () => {
    stubGetGamepads([null, null]);
    const onDismiss = vi.fn();
    await renderHint(true, onDismiss);
    const button = host.querySelector('button[aria-label="Dismiss hint"]');
    expect(button).not.toBeNull();
    await act(async () => {
      (button as HTMLButtonElement).click();
    });
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("auto-closes after a poll detects a newly-connected gamepad", async () => {
    vi.useFakeTimers();
    stubGetGamepads([null, null]);
    const onDismiss = vi.fn();
    await renderHint(true, onDismiss);
    // Gamepad plugs in after the hint is visible.
    stubGetGamepads([{ connected: true } as unknown as Gamepad]);
    await act(async () => {
      vi.advanceTimersByTime(1100);
    });
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});