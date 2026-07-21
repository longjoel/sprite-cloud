import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { touchPresetForPlatform } from "../../lib/ui/touch-preset";

describe("touch preset selection", () => {
  it.each([
    ["SNES", "snes"],
    ["snes", "snes"],
    ["Super Nintendo Entertainment System", "snes"],
    ["Nintendo - Super Nintendo Entertainment System", "snes"],
    ["Genesis", "genesis"],
    ["Sega Genesis", "genesis"],
    ["Mega Drive", "genesis"],
    ["sega mega drive", "genesis"],
    ["Sega - Mega Drive - Genesis", "genesis"],
  ])("maps %s before player bootstrap", (platform, expected) => {
    expect(touchPresetForPlatform(platform)).toBe(expected);
  });

  it("renders the preset onto the video before play-v2 initializes the virtual pad", () => {
    const source = readFileSync("components/GamePlayer.tsx", "utf8");
    expect(source).toContain("data-sc-preset={touchPresetForPlatform(platform)}");
    expect(source).not.toContain("if (!v || !connected) return;\n    // Map platform name to gamepad preset");
  });

  it("carries platform metadata through the unauthenticated LAN short-code resolver", () => {
    const route = readFileSync("app/api/room/resolve/[code]/route.ts", "utf8");
    const page = readFileSync("app/p/[code]/page.tsx", "utf8");
    expect(route).toContain("platform: game?.platform");
    expect(page).toContain("let platform = data.platform || \"\"");
  });
});
