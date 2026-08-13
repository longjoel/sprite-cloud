// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import PrivacyConsent from "@/components/PrivacyConsent";
import { CONSENT_STORAGE_KEY, readPrivacyConsent } from "@/lib/privacy-consent";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined;

function renderConsent() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(createElement(PrivacyConsent)));
  return container;
}

beforeEach(() => localStorage.clear());
afterEach(() => {
  if (root) act(() => root!.unmount());
  document.body.innerHTML = "";
  localStorage.clear();
  root = undefined;
});

describe("privacy consent", () => {
  it("persists necessary-only dismissal across remounts", async () => {
    let container = renderConsent();
    await act(async () => { await Promise.resolve(); });
    const necessary = [...document.body.querySelectorAll("button")].find((button) => button.textContent === "Necessary only") as HTMLButtonElement;
    act(() => necessary.click());
    expect(readPrivacyConsent()).toBe("necessary");

    act(() => root!.unmount());
    container.remove();
    root = undefined;
    container = renderConsent();
    await act(async () => { await Promise.resolve(); });
    expect(document.body.textContent).not.toContain("Your privacy choices");
  });

  it("persists analytics opt-in and emits a consent change", async () => {
    const listener = vi.fn();
    window.addEventListener("sc:privacy-consent", listener);
    renderConsent();
    await act(async () => { await Promise.resolve(); });
    const allow = [...document.body.querySelectorAll("button")].find((button) => button.textContent === "Allow analytics") as HTMLButtonElement;
    act(() => allow.click());
    expect(localStorage.getItem(CONSENT_STORAGE_KEY)).toBe("analytics");
    expect(listener).toHaveBeenCalledTimes(1);
    window.removeEventListener("sc:privacy-consent", listener);
  });

  it("can reopen choices and revoke analytics", async () => {
    localStorage.setItem(CONSENT_STORAGE_KEY, "analytics");
    renderConsent();
    await act(async () => { await Promise.resolve(); });
    act(() => window.dispatchEvent(new Event("sc:open-privacy-choices")));
    expect(document.body.textContent).toContain("Your privacy choices");
    const necessary = [...document.body.querySelectorAll("button")].find((button) => button.textContent === "Necessary only") as HTMLButtonElement;
    act(() => necessary.click());
    expect(readPrivacyConsent()).toBe("necessary");
  });

  it("treats malformed or obsolete stored state as no choice", async () => {
    localStorage.setItem(CONSENT_STORAGE_KEY, "accepted-v0");
    localStorage.setItem("ph_old_posthog", "identifier");
    renderConsent();
    await act(async () => { await Promise.resolve(); });
    expect(readPrivacyConsent()).toBeNull();
    expect(localStorage.getItem("ph_old_posthog")).toBeNull();
    expect(document.body.textContent).toContain("Your privacy choices");
  });

  it("removes legacy PostHog browser identifiers on necessary-only", async () => {
    localStorage.setItem("ph_old_posthog", "identifier");
    document.cookie = "ph_old_posthog=cookie; Path=/";
    renderConsent();
    await act(async () => { await Promise.resolve(); });
    const necessary = [...document.body.querySelectorAll("button")].find((button) => button.textContent === "Necessary only") as HTMLButtonElement;
    act(() => necessary.click());
    expect(localStorage.getItem("ph_old_posthog")).toBeNull();
    expect(document.cookie).not.toContain("ph_old_posthog=");
  });
});
