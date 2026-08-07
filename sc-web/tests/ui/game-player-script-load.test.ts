// @vitest-environment node
/**
 * Regression for #775: <script type="module"> onLoad never fires after
 * React SSR hydration.
 *
 * Verifies that GamePlayer:
 *  1. Uses Next.js <Script> component (not a plain HTML tag) — onLoad
 *     fires reliably with the Next.js lifecycle manager
 *  2. Includes a polling fallback (setInterval → window.scPlay) so the
 *     player initialises even if the onLoad callback misses
 *  3. Does NOT use a plain <script type="module"> JSX tag — the
 *     regression from #758
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const gamePlayerSource = readFileSync(
  resolve(process.cwd(), "components/GamePlayer.tsx"),
  "utf8",
);

describe("GamePlayer play-v2.js bootstrap", () => {
  it("uses Next.js <Script> component — not a plain <script> tag", () => {
    // The working pre-#758 approach: Next.js <Script type="module">.
    // The #758 regression replaced this with a plain <script type="module">
    // whose onLoad never fires after React SSR hydration.
    expect(gamePlayerSource).toMatch(/<Script[^>]*src="\/player\/play-v2\.js"/);
    expect(gamePlayerSource).toMatch(/type="module"/);
    expect(gamePlayerSource).toMatch(/onLoad=.*setScriptReady/);
    // Must NOT contain a plain <script> tag (regression guard)
    expect(gamePlayerSource).not.toMatch(/<script\s+type="module"\s+src="\/player\/play-v2\.js"/);
  });

  it("polls for window.scPlay as a fallback when onLoad misses", () => {
    // Belt-and-suspenders: the poll runs every 100ms for up to 15s,
    // catching window.scPlay regardless of whether React binds onLoad.
    expect(gamePlayerSource).toMatch(/window\.scPlay/);
    expect(gamePlayerSource).toMatch(/setInterval/);
    expect(gamePlayerSource).toMatch(/MAX_ATTEMPTS/);
    expect(gamePlayerSource).toMatch(/setScriptReady/);
    // The poll should check scPlay before starting the interval
    expect(gamePlayerSource).toMatch(/if\s*\(\s*window\.scPlay\s*\).*setScriptReady/);
  });

  it("documents why the <Script> component is used instead of a plain tag", () => {
    // The comment should make clear that Next.js <Script> is required for
    // reliable onLoad after hydration — someone in the future must not
    // "fix" the preload warning by swapping back to a plain tag.
    expect(gamePlayerSource).toContain("hydrat");
    expect(gamePlayerSource).toContain("onLoad");
  });
});
