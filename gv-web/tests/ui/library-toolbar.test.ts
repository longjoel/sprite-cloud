// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import LibraryToolbar from "@/components/LibraryToolbar";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const baseProps = {
  activeSection: "all" as const,
  counts: { all: 12, favorites: 3, recent: 4, pins: 2 },
  search: "mario",
  platforms: ["NES", "SNES"],
  platformCounts: { NES: 7, SNES: 5 },
  selectedPlatforms: new Set<string>(),
  viewMode: "grid" as const,
  onSectionChange: vi.fn(),
  onSearchChange: vi.fn(),
  onPlatformToggle: vi.fn(),
  onClearPlatforms: vi.fn(),
  onViewModeChange: vi.fn(),
};

let container: HTMLDivElement | undefined;
let root: Root | undefined;

function render(props = baseProps) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(createElement(LibraryToolbar, props)));
}

function click(selector: string) {
  const element = container!.querySelector(selector) as HTMLElement | null;
  expect(element, `missing ${selector}`).not.toBeNull();
  act(() => element!.click());
}

afterEach(() => {
  if (root) act(() => root!.unmount());
  root = undefined;
  container = undefined;
  document.body.innerHTML = "";
  vi.clearAllMocks();
});

describe("LibraryToolbar", () => {
  it("renders every section as a first-class accessible tab and preserves the search value", () => {
    const html = renderToStaticMarkup(createElement(LibraryToolbar, { ...baseProps, activeSection: "pins" }));
    expect(html).toContain('aria-label="Library sections"');
    expect(html).toContain("All (12)");
    expect(html).toContain("Favorites (3)");
    expect(html).toContain("Recently Played (4)");
    expect(html).toContain("Pinned (2)");
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain('value="mario"');
  });

  it("dispatches section and view clicks and search typing", () => {
    render();
    click('[aria-label="Library sections"] button:nth-child(2)');
    click('[aria-label="Table view"]');
    const search = container!.querySelector('[aria-label="Search games"]') as HTMLInputElement;
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    act(() => {
      setValue.call(search, "zelda");
      search.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(baseProps.onSectionChange).toHaveBeenCalledWith("favorites");
    expect(baseProps.onViewModeChange).toHaveBeenCalledWith("table");
    expect(baseProps.onSearchChange).toHaveBeenCalledWith("zelda");
  });

  it("opens the filter, toggles a system, removes a chip, and clears", () => {
    render({ ...baseProps, selectedPlatforms: new Set(["NES"]) });
    click('[aria-label="Filter by system"]');
    expect(container!.querySelector('[role="menu"]')).not.toBeNull();
    click('input[type="checkbox"]');
    click('[aria-label="Remove NES filter"]');
    click('[role="menu"] button');
    expect(baseProps.onPlatformToggle).toHaveBeenNthCalledWith(1, "NES");
    expect(baseProps.onPlatformToggle).toHaveBeenNthCalledWith(2, "NES");
    expect(baseProps.onClearPlatforms).toHaveBeenCalledOnce();
  });

  it("closes the systems popup on Escape", () => {
    render();
    click('[aria-label="Filter by system"]');
    expect(container!.querySelector('[role="menu"]')).not.toBeNull();
    const checkbox = container!.querySelector('input[type="checkbox"]') as HTMLInputElement;
    checkbox.focus();
    act(() => checkbox.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(container!.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(container!.querySelector('[aria-label="Filter by system"]'));
  });
});
