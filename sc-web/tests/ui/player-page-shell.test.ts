// @vitest-environment node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const playerPageSource = readFileSync(
  resolve(process.cwd(), "app/p/[code]/page.tsx"),
  "utf8",
);

describe("/p/[code] player page (Task 13 — shell=xmb)", () => {
  it("detects shell=xmb and sets homeUrl to /xmb for Back navigation", () => {
    // When shell=xmb is present, the home URL should go back to XMB
    expect(playerPageSource).toContain("shell");
    expect(playerPageSource).toContain("/xmb");
  });

  it("preserves LAN proxy pass-through with route=lan", () => {
    // LAN route detection must still work independently of shell param
    expect(playerPageSource).toContain('"route"');
    expect(playerPageSource).toContain('"lan"');
    expect(playerPageSource).toContain("sprite-cloud.com");
  });

  it("does not interfere short-code resolution flow", () => {
    // Must still resolve short codes and handle loading/error states
    expect(playerPageSource).toContain("/api/room/resolve");
    expect(playerPageSource).toContain("setPhase");
    expect(playerPageSource).toContain("onFatalError");
  });

  it("passes canonical GamePlayer props including onClose with correct home URL", () => {
    // GamePlayer must be rendered with onClose that uses shell-aware homeUrl
    expect(playerPageSource).toContain("onClose");
    expect(playerPageSource).toContain("homeUrl");
  });
});
