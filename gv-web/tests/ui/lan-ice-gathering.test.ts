import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("LAN ICE gathering", () => {
  const playerSource = readFileSync(resolve(process.cwd(), "public/player/gv-player.js"), "utf8");

  it("sends a direct LAN offer as soon as a host candidate exists", () => {
    expect(playerSource).toContain('get("route") === "lan"');
    expect(playerSource).toContain("isLanDirect ? 3_000");
    expect(playerSource).toContain("LAN host candidate ready");
    expect(playerSource).toContain("typ host");
  });
});