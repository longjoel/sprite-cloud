// @vitest-environment node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const playerShellSource = readFileSync(
  resolve(process.cwd(), "components/PlayerShell.tsx"),
  "utf8",
);

describe("/p/[code] player page", () => {
  it("preserves LAN proxy pass-through with route=lan", () => {
    const pageSource = readFileSync("app/p/[code]/page.tsx", "utf8");
    expect(pageSource).toContain('"route"');
    expect(pageSource).toContain('"lan"');
    expect(pageSource).toContain("sprite-cloud.com");
  });

  it("delegates to shared PlayerShell for resolve → loading → playing", () => {
    const shortCodePage = readFileSync("app/p/[code]/page.tsx", "utf8");
    expect(shortCodePage).toContain("PlayerShell");
    expect(shortCodePage).toContain("resolvePlayer");
    expect(playerShellSource).toContain("GamePlayer");
    expect(playerShellSource).toContain("onFatalError");
    expect(playerShellSource).toContain("onConnected");
  });

  it("renders GamePlayer through PlayerShell with close and home URL props", () => {
    expect(playerShellSource).toContain("onClose");
    expect(playerShellSource).toContain("homeUrl");
  });
});
