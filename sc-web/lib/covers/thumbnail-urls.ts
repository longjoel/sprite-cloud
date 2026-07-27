// Libretro thumbnail URL builder.
// Maps platform names to Libretro's system folder structure.
// https://thumbnails.libretro.com/

const THUMBNAIL_BASE = "https://thumbnails.libretro.com";

// Platform short name → Libretro system folder name.
// Keys match sc-server's PlatformManifest short_name values.
const SYSTEM_FOLDERS: Record<string, string> = {
  // Nintendo — Game Boy family
  "Game Boy Advance": "Nintendo - Game Boy Advance",
  "Game Boy Color": "Nintendo - Game Boy Color",
  "Game Boy": "Nintendo - Game Boy",
  // Nintendo — consoles
  NES: "Nintendo - Nintendo Entertainment System",
  "Family Computer Disk System": "Nintendo - Family Computer Disk System",
  SNES: "Nintendo - Super Nintendo Entertainment System",
  "Nintendo 64": "Nintendo - Nintendo 64",
  "Nintendo DS": "Nintendo - Nintendo DS",
  "Virtual Boy": "Nintendo - Virtual Boy",
  "Pokemon Mini": "Nintendo - Pokemon Mini",
  // Sega
  Genesis: "Sega - Mega Drive - Genesis",
  "Master System": "Sega - Master System - Mark III",
  "Game Gear": "Sega - Game Gear",
  "Sega CD": "Sega - Mega-CD - Sega CD",
  "Sega 32X": "Sega - 32X",
  Saturn: "Sega - Saturn",
  Dreamcast: "Sega - Dreamcast",
  // Sony
  PlayStation: "Sony - PlayStation",
  PSP: "Sony - PlayStation Portable",
  // Atari
  "Atari 2600": "Atari - 2600",
  "Atari 5200": "Atari - 5200",
  "Atari 7800": "Atari - 7800",
  "Atari Lynx": "Atari - Lynx",
  // NEC
  "PC Engine": "NEC - PC Engine - TurboGrafx-16",
  "TurboGrafx-16": "NEC - PC Engine - TurboGrafx-16",
  // SNK
  "Neo Geo Pocket": "SNK - Neo Geo Pocket",
  // Arcade
  MAME: "MAME",
  "Final Burn Neo": "FinalBurn Neo",
  // ScummVM
  ScummVM: "ScummVM",
  // Generic / fallback — list common aliases the library might surface
  "Nintendo - Nintendo Entertainment System": "Nintendo - Nintendo Entertainment System",
  "Nintendo - Super Nintendo Entertainment System": "Nintendo - Super Nintendo Entertainment System",
  "Nintendo - Game Boy": "Nintendo - Game Boy",
  "Nintendo - Game Boy Color": "Nintendo - Game Boy Color",
  "Nintendo - Game Boy Advance": "Nintendo - Game Boy Advance",
  "Nintendo - Nintendo 64": "Nintendo - Nintendo 64",
  "Nintendo - Nintendo DS": "Nintendo - Nintendo DS",
  "Nintendo - Virtual Boy": "Nintendo - Virtual Boy",
  "Sega - Mega Drive - Genesis": "Sega - Mega Drive - Genesis",
  "Sega - Master System - Mark III": "Sega - Master System - Mark III",
  "Sega - Game Gear": "Sega - Game Gear",
  "Sega - Saturn": "Sega - Saturn",
  "Sega - Dreamcast": "Sega - Dreamcast",
  "Sony - PlayStation": "Sony - PlayStation",
  "Sony - PlayStation Portable": "Sony - PlayStation Portable",
  "NEC - PC Engine - TurboGrafx-16": "NEC - PC Engine - TurboGrafx-16",
  "SNK - Neo Geo Pocket": "SNK - Neo Geo Pocket",
  "Atari - 2600": "Atari - 2600",
  "Atari - 5200": "Atari - 5200",
  "Atari - 7800": "Atari - 7800",
  "Atari - Lynx": "Atari - Lynx",
};

// Libretro image types, in priority order.
const BOXART_TYPES = ["Named_Boxarts", "Named_Snaps", "Named_Titles"] as const;

export interface ThumbnailUrls {
  boxart: string | null;
  screenshot: string | null;
  title: string | null;
}

/**
 * Sanitize a game name for use in a Libretro thumbnail filename.
 * Libretro replaces & and / with _ in filenames, then URI-encodes.
 */
function sanitizeFilename(name: string): string {
  return encodeURIComponent(
    name.replace(/&/g, "_").replace(/\//g, "_"),
  );
}

function buildUrl(
  systemFolder: string,
  type: string,
  gameName: string,
): string {
  const encodedSystem = encodeURIComponent(systemFolder);
  const encodedName = sanitizeFilename(gameName);
  return `${THUMBNAIL_BASE}/${encodedSystem}/${type}/${encodedName}.png`;
}

/**
 * Build Libretro thumbnail URLs for a game.
 * The boxart field is the primary cover image.
 * Returns null for unknown platforms.
 */
export function getThumbnailUrls(
  gameName: string,
  platform: string,
): ThumbnailUrls {
  const key = platform.trim();
  const systemFolder = SYSTEM_FOLDERS[key];
  if (!systemFolder) {
    return { boxart: null, screenshot: null, title: null };
  }

  return {
    boxart: buildUrl(systemFolder, "Named_Boxarts", gameName),
    screenshot: buildUrl(systemFolder, "Named_Snaps", gameName),
    title: buildUrl(systemFolder, "Named_Titles", gameName),
  };
}

/**
 * Return just the boxart URL for a game, or null if the platform is unknown.
 */
export function getBoxartUrl(
  gameName: string,
  platform: string,
): string | null {
  return getThumbnailUrls(gameName, platform).boxart;
}
