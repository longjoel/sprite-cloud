import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("LAN ICE gathering", () => {
  const playerSource = readFileSync(resolve(process.cwd(), "public/player/sc-player.js"), "utf8");
  const bootstrapSource = readFileSync(resolve(process.cwd(), "public/player/play-v2.js"), "utf8");

  it("sends a direct LAN offer as soon as a host candidate exists", () => {
    expect(playerSource).toContain('get("route") === "lan"');
    expect(playerSource).toContain("isLanDirect ? 3_000");
    expect(playerSource).toContain("LAN host candidate ready");
    expect(playerSource).toContain("typ host");
  });

  it("recognizes the sc-server LAN origin when route=lan is missing", () => {
    for (const source of [bootstrapSource, playerSource]) {
      expect(source).toContain('window.location.port === "8787"');
      expect(source).toContain("isPrivateIP(window.location.hostname)");
    }
    expect(bootstrapSource).toContain("payload.lan = true");
  });
});