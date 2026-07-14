// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import {
  activateXmbNavigation,
  activateXmbSettingsAction,
  getXmbNavigation,
  moveXmbNavigation,
  reconcileXmbNavigation,
} from "@/lib/ui/xmb-navigation";

describe("XMB category navigation", () => {
  it("uses exact dynamic positions without making Classic a content category", () => {
    expect(getXmbNavigation(false)).toEqual([
      { id: "games", kind: "category" },
      { id: "classic", kind: "action", href: "/" },
    ]);
    expect(getXmbNavigation(true)).toEqual([
      { id: "games", kind: "category" },
      { id: "settings", kind: "category" },
      { id: "classic", kind: "action", href: "/" },
    ]);
  });

  it("resets focus and content to Games when bootstrap removes active Settings", () => {
    expect(reconcileXmbNavigation({ focusedId: "settings", activeCategory: "settings" }, false)).toEqual({
      focusedId: "games",
      activeCategory: "games",
    });
  });

  it("keeps the real category body rendered while Classic is focused and navigates on activation", () => {
    const navigate = vi.fn();
    const state = { focusedId: "classic" as const, activeCategory: "settings" as const };

    expect(activateXmbNavigation(state, true, navigate)).toEqual(state);
    expect(navigate).toHaveBeenCalledWith("/");
  });

  it("moves through the dynamic Settings and Classic positions while only categories change content", () => {
    const games = { focusedId: "games" as const, activeCategory: "games" as const };
    const settings = moveXmbNavigation(games, true, 1);
    expect(settings).toEqual({ focusedId: "settings", activeCategory: "settings" });
    expect(moveXmbNavigation(settings, true, 1)).toEqual({
      focusedId: "classic",
      activeCategory: "settings",
    });
    expect(moveXmbNavigation(games, false, 1)).toEqual({
      focusedId: "classic",
      activeCategory: "games",
    });
  });
});

describe("XMB Settings gamepad actions", () => {
  it("activates pair-only and pair-plus-dashboard action sets by dynamic index", () => {
    const root = document.createElement("div");
    const pair = document.createElement("button");
    const dashboard = document.createElement("a");
    pair.dataset.xmbSettingsAction = "";
    dashboard.dataset.xmbSettingsAction = "";
    dashboard.href = "/dashboard";
    const pairClick = vi.fn();
    pair.addEventListener("click", pairClick);
    dashboard.addEventListener("click", (event) => event.preventDefault());
    document.body.append(root);
    root.append(pair);

    expect(activateXmbSettingsAction(root, 0)).toBe(true);
    expect(document.activeElement).toBe(pair);
    expect(activateXmbSettingsAction(root, 1)).toBe(true);
    expect(pairClick).toHaveBeenCalledTimes(2);

    root.append(dashboard);
    const dashboardClick = vi.spyOn(dashboard, "click");
    expect(activateXmbSettingsAction(root, 1)).toBe(true);
    expect(document.activeElement).toBe(dashboard);
    expect(dashboardClick).toHaveBeenCalledOnce();
  });
});
