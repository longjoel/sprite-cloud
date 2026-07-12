import type { PresetName } from "../touch-gamepad/types";

const PRESETS: Record<string, PresetName> = {
  nes: "nes",
  "nintendo entertainment system": "nes",
  snes: "snes",
  "super nintendo": "snes",
  "super nintendo entertainment system": "snes",
  genesis: "genesis",
  "sega genesis": "genesis",
  "mega drive": "genesis",
  "sega mega drive": "genesis",
  "master system": "genesis",
  "game gear": "genesis",
  "sega cd": "genesis",
  "sega 32x": "genesis",
  saturn: "genesis",
  dreamcast: "genesis",
  "atari 2600": "atari",
  "atari 5200": "atari",
  "atari 7800": "atari",
  "atari lynx": "atari",
  arcade: "arcade",
  "neo geo cd": "arcade",
};

export function touchPresetForPlatform(platform?: string | null): PresetName {
  const key = platform?.trim().toLowerCase() || "";
  return PRESETS[key] || "nes";
}
