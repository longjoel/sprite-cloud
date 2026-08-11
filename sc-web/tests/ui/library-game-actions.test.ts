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
  it("keys Favorite state by server and game in the main library", () => {
    expect(librarySource).toContain("isSavedGameFavorite(favoriteIds, game)");
    expect(librarySource).toContain("toggleSavedGameFavorite(prev, game)");
    expect(librarySource).not.toContain("favoriteIds.has(game.id)");
  });

  it("shows Play button and ⋮ context menu trigger in each table row", () => {
    const desktopActions = librarySource.match(/className="library-row-actions">([\s\S]*?)<\/div>/)?.[1];
    expect(desktopActions).toContain("More actions for ${game.name}");
    expect(desktopActions).toContain("Play");
    // Individual inline buttons are gone — actions are in context menu
    expect(desktopActions).not.toContain('<div className="library-row-secondary-actions">');
  });

  it("uses GameTileContextMenu in table rows instead of inline buttons", () => {
    const desktopActions = librarySource.match(/className="library-row-actions">([\s\S]*?)<\/div>/)?.[1];
    expect(desktopActions).toContain("GameTileContextMenu");
    expect(desktopActions).not.toContain("library-row-secondary-actions");
  });

  it("expands mobile row actions via context menu instead of fixed overflow", () => {
    // Context menus expand naturally outside the table — no static overflow needed
    expect(librarySource).toContain("GameTileContextMenu");
    expect(librarySource).not.toContain("library-row-overflow");
  });
});

describe("GameTile actions", () => {
  it("context menu renders as a portal avoiding tile clip boundaries", () => {
    // MUI Menu renders in a portal — no overflow:hidden escape hacks needed
    const html = renderToStaticMarkup(createElement(GameTile, { game, onPlay: vi.fn(), onToggleFavorite: vi.fn() }));
    expect(html).not.toContain("game-tile-overflow");
    expect(librarySource).toContain("GameTileContextMenu");
  });

  it("keeps title and platform as the only persistent metadata", () => {
    const html = renderToStaticMarkup(createElement(GameTile, { game, onPlay: vi.fn() }));
    expect(html).toContain("Super Test");
    expect(html).toContain("SNES");
    expect(html).not.toContain("4p");
  });

  it("shows a verified badge only when DAT evidence exists", () => {
    const html = renderToStaticMarkup(createElement(GameTile, {
      game: { ...game, verification: { state: "verified" } },
      onPlay: vi.fn(),
    }));
    expect(html).toContain("game-tile-verification");
    expect(html).toContain("✓ Verified");

    // No badge without evidence — tiles stay clean.
    const plain = renderToStaticMarkup(createElement(GameTile, { game, onPlay: vi.fn() }));
    expect(plain).not.toContain("game-tile-verification");
  });

  it("marks unverified games distinctly without an approval gate", () => {
    const html = renderToStaticMarkup(createElement(GameTile, {
      game: { ...game, verification: { state: "unverified" } },
      onPlay: vi.fn(),
    }));
    expect(html).toContain("Unverified");
    expect(html).toContain("game-tile-verification-unverified");
    expect(html).not.toContain("Reject");
    expect(html).not.toContain("Approve");
  });

  it("provides a large labelled Play target and a ⋮ context-menu trigger", () => {
    const html = renderToStaticMarkup(createElement(GameTile, {
      game,
      isFavorite: true,

      onPlay: vi.fn(),
      onToggleFavorite: vi.fn(),

      onEdit: vi.fn(),
    }));
    expect(html).toContain('aria-label="Play Super Test"');
    expect(html).not.toContain('aria-label="Pin Super Test"');
    expect(html).toContain('aria-label="More actions for Super Test"');
    // Secondary actions live in the context menu — not as standalone buttons
    expect(html).not.toContain('aria-label="Remove Super Test from favorites"');
    expect(html).not.toContain('aria-label="Rename Super Test"');
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
    expect(onPlay).toHaveBeenCalledWith(game);
  });

  it("runs a secondary action from the context menu without launching the game", () => {
    const onPlay = vi.fn();
    const onToggleFavorite = vi.fn();
    const tile = renderTile({ onPlay, onToggleFavorite });
    // Open the context menu via the ⋮ trigger
    const trigger = tile.querySelector('[aria-label="More actions for Super Test"]') as HTMLButtonElement;
    act(() => trigger.click());
    // Context menu should be open now — find and click the favorite action
    const menu = document.querySelector('[role="menu"]');
    expect(menu).not.toBeNull();
    const favItem = menu!.querySelector('[role="menuitem"]') as HTMLElement;
    expect(favItem).not.toBeNull();
    act(() => favItem.click());
    expect(onToggleFavorite).toHaveBeenCalledOnce();
    expect(onToggleFavorite).toHaveBeenCalledWith(game, expect.anything());
    expect(onPlay).not.toHaveBeenCalled();
  });

  it("uses a keyboard-focusable ⋮ button to open the context menu", () => {
    const tile = renderTile({ onToggleFavorite: vi.fn(), onEdit: vi.fn() });
    const trigger = tile.querySelector('[aria-label="More actions for Super Test"]');
    expect(trigger?.tagName).toBe("BUTTON");
    expect((trigger as HTMLButtonElement).disabled).toBe(false);
  });

  it("context menu actions are hidden until the trigger is activated", () => {
    const tile = renderTile({ onToggleFavorite: vi.fn(), onEdit: vi.fn() });
    // Context menu should not be visible before trigger activation
    expect(document.querySelector('[role="menu"]')).toBeNull();
  });

  it("disables Play during launch while keeping the context menu trigger available", () => {
    const tile = renderTile({ onChooseHost: vi.fn(), launching: true });
    const play = tile.querySelector('[aria-label="Play Super Test"]') as HTMLButtonElement;
    const trigger = tile.querySelector('[aria-label="More actions for Super Test"]') as HTMLButtonElement;

    expect(play.tagName).toBe("BUTTON");
    expect(trigger.tagName).toBe("BUTTON");
    expect(play.disabled).toBe(true);
    expect(trigger.disabled).toBe(false);
    expect(tile.querySelector(".MuiCircularProgress-root")).not.toBeNull();
  });

  it("shows action menu through a recognisable ⋮ icon", () => {
    const tile = renderTile({ onChooseHost: vi.fn() });
    const trigger = tile.querySelector('[aria-label="More actions for Super Test"]') as HTMLButtonElement;
    expect(trigger.querySelector("svg")).not.toBeNull();
    expect(trigger.querySelector("svg")?.getAttribute("focusable")).toBe("false");
  });
});

describe("host selection actions", () => {
  it("offers an explicit host override without persisting ordinary selections", () => {
    expect(librarySource).toContain("Always use this host");
    expect(librarySource).toContain("openHostPicker(game, !automatic)");
    expect(librarySource).not.toContain("const generation = openHostPicker(game);\n    setLaunchingGame");
    expect(librarySource).toContain("if (rememberSelectedHost) setPreferredServer(game.id, serverId);");
    expect(librarySource).not.toContain("setPreferredServer(game.id, serverId);\n        const probe");
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
