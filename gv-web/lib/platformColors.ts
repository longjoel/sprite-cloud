// ── Platform-to-background-color mapping ──────────────────────────
//
// Each platform gets a distinct color used as the tile background when
// no artwork or screenshot is available.

const PALETTE: Record<string, string> = {
  // Nintendo
  nes:             "#bf2a36", // Nintendo red
  "nintendo entertainment system": "#bf2a36",
  snes:            "#5a3d8a", // SNES purple
  "super nintendo": "#5a3d8a",
  "super nintendo entertainment system": "#5a3d8a",
  n64:             "#1e6b3a", // N64 green
  "nintendo 64":   "#1e6b3a",
  gamecube:        "#5a2d82", // indigo
  wii:             "#3a7bc8", // Wii blue
  wiiu:            "#3a7bc8",
  "wii u":         "#3a7bc8",
  switch:          "#c9161e", // Switch red
  "nintendo switch": "#c9161e",
  gb:              "#6b8e1e", // Game Boy green
  "game boy":      "#6b8e1e",
  gbc:             "#5a8a8a", // Game Boy Color teal
  "game boy color": "#5a8a8a",
  gba:             "#6a2c8a", // GBA purple
  "game boy advance": "#6a2c8a",
  nds:             "#6b6b6b", // DS silver
  "nintendo ds":   "#6b6b6b",
  "3ds":           "#b8305a", // 3DS pink
  "nintendo 3ds":  "#b8305a",
  virtualboy:      "#c9302c", // Virtual Boy red
  "virtual boy":   "#c9302c",

  // Sega
  genesis:         "#1e3660", // Sega blue
  "sega genesis":  "#1e3660",
  "mega drive":    "#1e3660",
  "sega mega drive": "#1e3660",
  "master system": "#8b1a1a", // dark red
  "sega master system": "#8b1a1a",
  "game gear":     "#2d5a8e", // blue
  "sega game gear": "#2d5a8e",
  saturn:          "#3a3a3a", // dark gray
  "sega saturn":   "#3a3a3a",
  dreamcast:       "#c46a1a", // Dreamcast orange
  "sega dreamcast": "#c46a1a",
  "sega cd":       "#3a3a3a",
  "sega 32x":      "#5a2a5a",

  // Sony
  ps1:             "#1e3460", // PlayStation blue
  playstation:     "#1e3460",
  "playstation 1": "#1e3460",
  ps2:             "#1e2e5a", // PS2 deep blue
  "playstation 2": "#1e2e5a",
  ps3:             "#2a2a4a", // PS3 dark
  "playstation 3": "#2a2a4a",
  psp:             "#3a4a6a", // PSP blue-gray
  "playstation portable": "#3a4a6a",
  psx:             "#1e3460",

  // Microsoft
  xbox:            "#2d6b2d", // Xbox green
  "xbox 360":      "#3a8a3a",
  xbox360:         "#3a8a3a",
  "xbox one":      "#2d6b2d",
  xboxone:         "#2d6b2d",

  // NEC / Hudson
  pcengine:         "#b05a1e", // PC Engine orange
  "pc engine":      "#b05a1e",
  turbografx16:     "#b05a1e",
  "turbografx-16":  "#b05a1e",
  "pc-fx":          "#6a3a5a",

  // SNK
  neogeo:          "#b8961e", // Neo Geo gold
  "neo geo":       "#b8961e",
  "neo geo pocket": "#5a6a3a",
  ngp:             "#5a6a3a",

  // Atari
  "atari 2600":    "#6b3a1e", // wood-grain brown
  atari2600:       "#6b3a1e",
  "atari 5200":    "#4a3a6a",
  "atari 7800":    "#5a3a2a",
  lynx:            "#3a5a3a",
  jaguar:          "#8a1e1e",

  // Other
  "commodore 64":  "#4a5a8a",
  c64:             "#4a5a8a",
  amiga:           "#5a4a2a",
  "commodore amiga": "#5a4a2a",
  msx:             "#3a3a6a",
  "msx2":          "#4a4a7a",
  dos:             "#3a3a4a",
  "pc dos":        "#3a3a4a",
  "windows":       "#2a5a8a",
  scummvm:         "#5a4a2a",
  "scumm vm":      "#5a4a2a",
  ports:           "#4a4a5a",
  "native ports":  "#4a4a5a",

  // Arcade
  mame:            "#c64a1e", // arcade orange
  arcade:          "#c64a1e",
  fba:             "#c64a1e",
  "final burn alpha": "#c64a1e",

  // Default — will be overridden by hash
  unknown:         "#3a3a4a",
};

type Rgb = [number, number, number];

function hexToRgb(hex: string): Rgb {
  const h = hex.replace("#", "");
  return [
    parseInt(h.substring(0, 2), 16),
    parseInt(h.substring(2, 4), 16),
    parseInt(h.substring(4, 6), 16),
  ];
}

function rgbToHex(r: number, g: number, b: number): string {
  return `#${[r, g, b].map((c) => Math.max(0, Math.min(255, Math.round(c))).toString(16).padStart(2, "0")).join("")}`;
}

// Darken a hex color by blending with black
function darken(hex: string, factor: number): string {
  const [r, g, b] = hexToRgb(hex);
  return rgbToHex(r * factor, g * factor, b * factor);
}

// Simple string hash → hue-based color for unknown platforms
function hashColor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = ((h << 5) - h + name.charCodeAt(i)) | 0;
  const hue = Math.abs(h) % 360;
  return `hsl(${hue}, 45%, 18%)`;
}

/**
 * Get the background color for a platform tile.
 * Uses the predefined palette; falls back to a hash-based hue for unknown platforms.
 * The returned color is darkened slightly for use as a card background.
 */
export function getPlatformColor(platform: string): string {
  const key = platform.toLowerCase().trim();
  const hex = PALETTE[key] ?? hashColor(platform);

  // Darken by ~20% so the color works well as a card background
  // and text overlays remain readable
  return hex.startsWith("#") ? darken(hex, 0.8) : hex;
}

/**
 * Returns the "brand" color (undarkened) for badges / accents.
 */
export function getPlatformAccent(platform: string): string {
  const key = platform.toLowerCase().trim();
  const hex = PALETTE[key] ?? hashColor(platform);
  return hex.startsWith("#") ? hex : hex.replace("45%", "60%").replace("18%", "25%");
}
