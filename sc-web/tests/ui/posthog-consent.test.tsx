// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  process.env.NEXT_PUBLIC_POSTHOG_KEY = "test-key";
  process.env.NEXT_PUBLIC_POSTHOG_HOST = "https://posthog.example";
  return { init: vi.fn(), capture: vi.fn(), optIn: vi.fn(), optOut: vi.fn(), reset: vi.fn() };
});
vi.mock("posthog-js", () => ({ default: { init: mocks.init, capture: mocks.capture, opt_in_capturing: mocks.optIn, opt_out_capturing: mocks.optOut, reset: mocks.reset } }));
vi.mock("next/navigation", () => ({ usePathname: () => "/privacy" }));

import PostHogProvider from "@/components/PostHogProvider";
import { CONSENT_STORAGE_KEY } from "@/lib/privacy-consent";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined;

function renderProvider() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(createElement(PostHogProvider, null, "child")));
}

beforeEach(() => { localStorage.clear(); vi.clearAllMocks(); });
afterEach(() => { if (root) act(() => root!.unmount()); document.body.innerHTML = ""; localStorage.clear(); root = undefined; });

describe("PostHog consent gating", () => {
  it("does not initialize analytics without explicit consent", () => {
    renderProvider();
    expect(mocks.init).not.toHaveBeenCalled();
    expect(mocks.capture).not.toHaveBeenCalled();
  });

  it("initializes with local-storage persistence after opt-in", () => {
    localStorage.setItem(CONSENT_STORAGE_KEY, "analytics");
    renderProvider();
    expect(mocks.init).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ persistence: "localStorage" }));
    expect(mocks.optIn).toHaveBeenCalled();
    expect(mocks.capture).toHaveBeenCalledWith("$pageview", { path: "/privacy" });
  });

  it("opts out and resets analytics when consent is revoked", () => {
    localStorage.setItem(CONSENT_STORAGE_KEY, "analytics");
    renderProvider();
    act(() => {
      localStorage.setItem(CONSENT_STORAGE_KEY, "necessary");
      localStorage.setItem("ph_active_posthog", "identifier");
      window.dispatchEvent(new CustomEvent("sc:privacy-consent", { detail: "necessary" }));
    });
    expect(mocks.optOut).toHaveBeenCalled();
    expect(mocks.reset).toHaveBeenCalled();
    expect(localStorage.getItem("ph_active_posthog")).toBeNull();
  });
});
