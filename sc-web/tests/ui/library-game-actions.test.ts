// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import GameTile from "@/components/fluent/GameTile";

const librarySource = readFileSync("components/LibraryClient.tsx", "utf8");
const tileStyles = readFileSync("components/fluent/tiles.css", "utf8");
const game = { id: "game-1", name: "Super Test", platform: "SNES", maxPlayers: 4 };
let root: Root | undefined;
let container: HTMLDivElement | undefined;

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  if (root) act(() => root!.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
});

function renderTile(props: Partial<React.ComponentProps<typeof GameTile>> = {}) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(createElement(GameTile, { game, onPlay: vi.fn(), ...props })));
  return container;
}

describe("library presentation chrome", () => {
  it("renders the collection directly without redundant view wrappers", () => {
    expect(librarySource).not.toContain("Tile view");
    expect(librarySource).not.toContain("Table view");
    expect(librarySource).not.toContain("librarySurfaceCard");
    expect(librarySource).not.toContain("librarySurfaceHeader");
  });

  it("uses initial skeletons and a subtle infinite-load sentinel", () => {
    expect(librarySource).not.toContain(">Loading...</");
    expect(librarySource).toContain("library-skeleton-grid");
    expect(librarySource).toContain("library-load-sentinel");
  });
});

describe("classic table row actions", () => {
  it("provides a labelled mobile overflow menu with labelled action rows", () => {
    expect(librarySource).toContain('className="library-row-overflow"');
    expect(librarySource).toContain('className="library-row-overflow-actions"');
    expect(librarySource).toContain("More actions for ${game.name}");
    expect(librarySource).toContain("Add ${game.name} to favorites");
    expect(librarySource).toContain("Pin ${game.name}");
    expect(librarySource).toContain("Rename ${game.name}");
  });

  it("expands mobile row actions in document flow instead of clipping them in the table scroller", () => {
    expect(tileStyles).toMatch(/@media \(max-width:640px\)[\s\S]*\.library-row-overflow-actions\s*\{[^}]*position:\s*static/);
  });
});

describe("GameTile actions", () => {
  it("lets an open mobile action menu escape the tile clipping boundary", () => {
    expect(tileStyles).toMatch(/\.game-tile:has\(\.game-tile-overflow\[open\]\)\s*\{[^}]*overflow:\s*visible/);
  });

  it("keeps title and platform as the only persistent metadata", () => {
    const html = renderToStaticMarkup(createElement(GameTile, { game, onPlay: vi.fn() }));
    expect(html).toContain("Super Test");
    expect(html).toContain("SNES");
    expect(html).not.toContain("4p");
  });

  it("provides a large labelled Play target and labelled secondary actions", () => {
    const html = renderToStaticMarkup(createElement(GameTile, {
      game,
      isFavorite: true,
      isPinned: false,
      onPlay: vi.fn(),
      onToggleFavorite: vi.fn(),
      onTogglePin: vi.fn(),
      onEdit: vi.fn(),
    }));
    expect(html).toContain('aria-label="Play Super Test"');
    expect(html).toContain('aria-label="Remove Super Test from favorites"');
    expect(html).toContain('aria-label="Pin Super Test"');
    expect(html).toContain('aria-label="Rename Super Test"');
    expect(html).toContain('aria-label="More actions for Super Test"');
  });

  it("plays from the primary button without making the card itself interactive", () => {
    const onPlay = vi.fn();
    const tile = renderTile({ onPlay });
    expect(tile.querySelector(".game-tile")?.getAttribute("role")).toBe("group");
    expect(tile.querySelector(".game-tile")?.getAttribute("tabindex")).toBeNull();
    const play = tile.querySelector('[aria-label="Play Super Test"]');
    expect(play?.tagName).toBe("BUTTON");
    act(() => (play as HTMLButtonElement).click());
    expect(onPlay).toHaveBeenCalledOnce();
    expect(onPlay).toHaveBeenCalledWith("game-1");
  });

  it("runs a secondary action without also launching the game", () => {
    const onPlay = vi.fn();
    const onToggleFavorite = vi.fn();
    const tile = renderTile({ onPlay, onToggleFavorite });
    act(() => (tile.querySelector('.game-tile-secondary-actions [aria-label="Add Super Test to favorites"]') as HTMLButtonElement).click());
    expect(onToggleFavorite).toHaveBeenCalledOnce();
    expect(onToggleFavorite).toHaveBeenCalledWith("game-1", expect.anything());
    expect(onPlay).not.toHaveBeenCalled();
  });

  it("uses keyboard-focusable native controls for the mobile menu and its actions", () => {
    const tile = renderTile({ onToggleFavorite: vi.fn(), onTogglePin: vi.fn(), onEdit: vi.fn() });
    const menuTrigger = tile.querySelector('[aria-label="More actions for Super Test"]');
    const menuActions = [...tile.querySelectorAll(".game-tile-overflow-actions button")];
    expect(menuTrigger?.tagName).toBe("SUMMARY");
    expect(menuActions).toHaveLength(3);
    expect(menuActions.every((action) => action.tagName === "BUTTON" && !(action as HTMLButtonElement).disabled)).toBe(true);
  });

  it("disables Play and host selection during launch without removing native controls", () => {
    const tile = renderTile({ onChooseHost: vi.fn(), launching: true });
    const play = tile.querySelector('[aria-label="Play Super Test"]') as HTMLButtonElement;
    const choose = tile.querySelector('.game-tile-secondary-actions [aria-label="Choose host for Super Test"]') as HTMLButtonElement;

    expect(play.tagName).toBe("BUTTON");
    expect(choose.tagName).toBe("BUTTON");
    expect(play.disabled).toBe(true);
    expect(choose.disabled).toBe(true);
    expect(play.textContent).toContain("Launching");
  });

  it("uses a recognizable Fluent desktop icon and a visible desktop label", () => {
    const tile = renderTile({ onChooseHost: vi.fn() });
    const choose = tile.querySelector('.game-tile-secondary-actions [aria-label="Choose host for Super Test"]') as HTMLButtonElement;
    expect(choose.querySelector("svg")).not.toBeNull();
    expect(choose.textContent).toContain("Host");
    expect(choose.textContent).not.toContain("⌁");
  });
});

describe("host selection actions", () => {
  it("offers an explicit host override without persisting ordinary selections", () => {
    expect(librarySource).toContain("Choose host for ${game.name}");
    expect(librarySource).toContain("Always use this host");
    expect(librarySource).toContain("openHostPicker(gameId, !automatic)");
    expect(librarySource).not.toContain("const generation = openHostPicker(gameId);\n    setLaunchingGame");
    expect(librarySource).toContain("if (rememberSelectedHost) setPreferredServer(gameId, serverId);");
    expect(librarySource).not.toContain("setPreferredServer(gameId, serverId);\n        const probe");
  });

  it("shows launch errors with retry and resets remembered selection on every close path", () => {
    expect(librarySource).toContain('role="alert"');
    expect(librarySource).toContain("Retry");
    expect(librarySource).toContain("setRememberSelectedHost(false)");
    expect(librarySource).toContain("closeHostPicker");
    expect(librarySource).not.toContain("catch { /* silent */ }");
  });
});

describe("motion preferences", () => {
  it("disables indefinite library animations when reduced motion is requested", () => {
    expect(tileStyles).toMatch(/@media \(prefers-reduced-motion:reduce\)/);
    expect(tileStyles).toMatch(/library-skeleton-tile[^}]*animation:\s*none!important/);
  });
});
