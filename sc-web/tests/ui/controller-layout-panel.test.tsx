// @vitest-environment jsdom

import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ControllerLayoutPanel from "@/components/ControllerLayoutPanel";

describe("Controller Layout panel", () => {
  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(() => {
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  it("offers opacity and size presets before freeform editing", async () => {
    const controller = {
      setOpacity: vi.fn(),
      setSizePreset: vi.fn(),
      swapAB: vi.fn(),
      resetLayout: vi.fn(),
      exitEditMode: vi.fn(),
    };
    const onCustomize = vi.fn();
    const host = document.createElement("div");
    document.body.appendChild(host);

    await act(async () => {
      createRoot(host).render(
        <ControllerLayoutPanel
          controller={controller}
          onBack={vi.fn()}
          onClose={vi.fn()}
          onCustomize={onCustomize}
          onHide={vi.fn()}
        />,
      );
    });
    const click = async (name: string) => {
      const button = Array.from(host.querySelectorAll("button")).find((item) => item.textContent?.includes(name));
      expect(button, `${name} button`).toBeDefined();
      await act(async () => button!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    };

    await click("Low");
    await click("Medium");
    await click("High");
    await click("Compact");
    await click("Standard");
    await click("Large");
    await click("Customize");

    expect(controller.setOpacity.mock.calls).toEqual([["low"], ["medium"], ["high"]]);
    expect(controller.setSizePreset.mock.calls).toEqual([["compact"], ["standard"], ["large"]]);
    expect(onCustomize).toHaveBeenCalledOnce();
  });

  it("wires lock, reset, swap, and hide replacements in the dedicated panel", async () => {
    const controller = {
      setOpacity: vi.fn(), setSizePreset: vi.fn(), swapAB: vi.fn(),
      resetLayout: vi.fn(), exitEditMode: vi.fn(),
    };
    const onHide = vi.fn();
    const host = document.createElement("div");
    document.body.appendChild(host);
    await act(async () => {
      createRoot(host).render(
        <ControllerLayoutPanel controller={controller} onBack={vi.fn()} onClose={vi.fn()}
          onCustomize={vi.fn()} onHide={onHide} />,
      );
    });
    const click = async (name: string) => {
      const button = Array.from(host.querySelectorAll("button")).find((item) => item.textContent?.includes(name))!;
      await act(async () => button.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    };

    await click("Lock Layout");
    await click("Reset Layout");
    await click("Swap A/B");
    await click("Hide Controls");

    expect(controller.exitEditMode).toHaveBeenCalledOnce();
    expect(controller.resetLayout).toHaveBeenCalledOnce();
    expect(controller.swapAB).toHaveBeenCalledOnce();
    expect(onHide).toHaveBeenCalledOnce();
  });

  it("closes from its backdrop but not from clicks inside the shared modal surface", async () => {
    const onClose = vi.fn();
    const host = document.createElement("div");
    document.body.appendChild(host);
    await act(async () => {
      createRoot(host).render(
        <ControllerLayoutPanel onBack={vi.fn()} onClose={onClose}
          onCustomize={vi.fn()} onHide={vi.fn()} />,
      );
    });

    const dialog = host.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(dialog).toHaveProperty("dataset.playerPanel");
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    await act(async () => dialog.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(onClose).not.toHaveBeenCalled();

    await act(async () => dialog.parentElement!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("disables controller-dependent actions when the controller API is unavailable", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    await act(async () => {
      createRoot(host).render(
        <ControllerLayoutPanel onBack={vi.fn()} onClose={vi.fn()}
          onCustomize={vi.fn()} onHide={vi.fn()} />,
      );
    });

    const button = (name: string) => Array.from(host.querySelectorAll("button"))
      .find((item) => item.textContent?.includes(name))!;
    for (const name of ["Low", "Medium", "High", "Compact", "Standard", "Large",
      "Lock Layout", "Reset Layout", "Swap A/B"]) {
      expect(button(name).disabled, `${name} should be disabled`).toBe(true);
    }
    expect(button("Customize Position").disabled).toBe(false);
    expect(button("Hide Controls").disabled).toBe(false);
  });

  it("restores truthful selected opacity and size choices when the panel remounts", async () => {
    const controller = {
      getOpacity: () => "high" as const,
      getSizePreset: () => "standard" as const,
      setOpacity: vi.fn(), setSizePreset: vi.fn(), swapAB: vi.fn(),
      resetLayout: vi.fn(), exitEditMode: vi.fn(),
    };
    const host = document.createElement("div");
    document.body.appendChild(host);
    let root = createRoot(host);
    await act(async () => {
      root.render(
        <ControllerLayoutPanel controller={controller} onBack={vi.fn()} onClose={vi.fn()}
          onCustomize={vi.fn()} onHide={vi.fn()} />,
      );
    });
    const button = (name: string) => Array.from(host.querySelectorAll("button"))
      .find((item) => item.textContent?.includes(name))!;

    expect(button("High").getAttribute("aria-pressed")).toBe("true");
    expect(button("Low").getAttribute("aria-pressed")).toBe("false");
    expect(button("Standard").getAttribute("aria-pressed")).toBe("true");

    await act(async () => button("Large").dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(button("Large").getAttribute("aria-pressed")).toBe("true");
    expect(button("Compact").getAttribute("aria-pressed")).toBe("false");

    await act(async () => root.unmount());
    root = createRoot(host);
    await act(async () => {
      root.render(
        <ControllerLayoutPanel controller={controller} onBack={vi.fn()} onClose={vi.fn()}
          onCustomize={vi.fn()} onHide={vi.fn()} />,
      );
    });
    expect(button("Standard").getAttribute("aria-pressed")).toBe("true");
    expect(button("Large").getAttribute("aria-pressed")).toBe("false");
  });

  it("does not press a named size when the controller reports a custom resize", async () => {
    const controller = {
      getOpacity: () => "medium" as const,
      getSizePreset: () => "custom" as const,
      setOpacity: vi.fn(), setSizePreset: vi.fn(), swapAB: vi.fn(),
      resetLayout: vi.fn(), exitEditMode: vi.fn(),
    };
    const host = document.createElement("div");
    document.body.appendChild(host);
    await act(async () => {
      createRoot(host).render(
        <ControllerLayoutPanel controller={controller} onBack={vi.fn()} onClose={vi.fn()}
          onCustomize={vi.fn()} onHide={vi.fn()} />,
      );
    });

    for (const name of ["Compact", "Standard", "Large"]) {
      const button = Array.from(host.querySelectorAll("button"))
        .find((item) => item.textContent?.includes(name))!;
      expect(button.getAttribute("aria-pressed")).toBe("false");
    }
  });

  it("visibly styles pressed choices with the Metro sky accent and square corners", () => {
    const css = readFileSync("components/ControllerLayoutPanel.module.css", "utf8");

    expect(css).toMatch(/\.choice\[aria-pressed=["']true["']\]\s*\{[^}]*#38bdf8[^}]*border-radius:\s*2px/i);
  });
});
