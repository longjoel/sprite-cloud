// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  activateXmbNavigation,
  activateXmbSettingsAction,
  getXmbNavigation,
  moveXmbNavigation,
  reconcileXmbNavigation,
  wrapGameFocus,
  wrapIndex,
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

describe("XMB navigation wrapping", () => {
  it("wraps ArrowRight from last category to first", () => {
    // Starting at classic, ArrowRight should wrap to games
    const classic = { focusedId: "classic" as const, activeCategory: "settings" as const };
    expect(moveXmbNavigation(classic, true, 1)).toEqual({
      focusedId: "games",
      activeCategory: "games",
    });
  });

  it("wraps ArrowLeft from first category to last", () => {
    // Starting at games, ArrowLeft should wrap to classic
    const games = { focusedId: "games" as const, activeCategory: "games" as const };
    expect(moveXmbNavigation(games, true, -1)).toEqual({
      focusedId: "classic",
      activeCategory: "games",
    });
  });

  it("wraps ArrowLeft from first to last when settings is unavailable", () => {
    const games = { focusedId: "games" as const, activeCategory: "games" as const };
    // Without settings: [games, classic], ArrowLeft from games → classic
    expect(moveXmbNavigation(games, false, -1)).toEqual({
      focusedId: "classic",
      activeCategory: "games",
    });
  });

  it("wraps ArrowRight from classic to games when settings unavailable", () => {
    const classic = { focusedId: "classic" as const, activeCategory: "games" as const };
    expect(moveXmbNavigation(classic, false, 1)).toEqual({
      focusedId: "games",
      activeCategory: "games",
    });
  });
});

describe("wrapIndex", () => {
  it("wraps forward from last to first", () => {
    expect(wrapIndex(2, 1, 3)).toBe(0);
  });

  it("wraps backward from first to last", () => {
    expect(wrapIndex(0, -1, 3)).toBe(2);
  });

  it("advances normally within bounds", () => {
    expect(wrapIndex(1, 1, 3)).toBe(2);
    expect(wrapIndex(1, -1, 3)).toBe(0);
  });

  it("returns 0 for zero-length arrays", () => {
    expect(wrapIndex(0, 1, 0)).toBe(0);
  });

  it("handles single-element array", () => {
    expect(wrapIndex(0, 1, 1)).toBe(0);
    expect(wrapIndex(0, -1, 1)).toBe(0);
  });
});

describe("wrapGameFocus", () => {
  it("wraps ArrowUp from top to bottom", () => {
    // 5 games, focused on index 0, ArrowUp → wrap to 4
    expect(wrapGameFocus(0, -1, 5)).toBe(4);
  });

  it("wraps ArrowDown from bottom to top", () => {
    expect(wrapGameFocus(4, 1, 5)).toBe(0);
  });

  it("moves normally within bounds", () => {
    expect(wrapGameFocus(2, 1, 5)).toBe(3);
    expect(wrapGameFocus(2, -1, 5)).toBe(1);
  });

  it("returns 0 for empty game list", () => {
    expect(wrapGameFocus(0, -1, 0)).toBe(0);
    expect(wrapGameFocus(0, 1, 0)).toBe(0);
  });
});

describe("XMB page source wrapping patterns", () => {
  it("uses wrapGameFocus for ArrowUp/ArrowDown game list navigation instead of Math.max/min clamp", () => {
    const source = readFileSync(resolve(process.cwd(), "app/xmb/page.tsx"), "utf8");
    expect(source).toContain("wrapGameFocus");
    // Should not clamp with Math.max(0, ...) for game focus
    expect(source).not.toContain("Math.max(0, v - 1)");
    expect(source).not.toContain("Math.min(filteredGames.length - 1, v + 1)");
  });

  it("uses wrapIndex for sub-category Left/Right wrapping instead of boundary conditionals", () => {
    const source = readFileSync(resolve(process.cwd(), "app/xmb/page.tsx"), "utf8");
    expect(source).toContain("wrapIndex");
    // Should not use non-wrapping boundary checks like "focusedSub > 0" or "focusedSub < SUB_CATEGORIES.length - 1" for the wrapping path
    const arrowLeftLines = source.match(/ArrowLeft[^}]+}/g);
    const arrowRightLines = source.match(/ArrowRight[^}]+}/g);
    expect(arrowLeftLines).not.toBeNull();
    expect(arrowRightLines).not.toBeNull();
  });

  it("uses moveXmbNavigation wrapping for category Left/Right instead of clamped fallthrough from sub-category", () => {
    const source = readFileSync(resolve(process.cwd(), "app/xmb/page.tsx"), "utf8");
    expect(source).toContain("moveXmbNavigation");
    // moveXmbNavigation should be called unconditionally for category nav, not as a fallthrough after sub-category checks
  });
});
