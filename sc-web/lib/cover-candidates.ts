import { createHmac, timingSafeEqual } from "crypto";

export const RETROARCH_TYPES = {
  boxart: "Named_Boxarts",
  title: "Named_Titles",
  screenshot: "Named_Snaps",
} as const;
export type RetroarchArtworkType = keyof typeof RETROARCH_TYPES;

const PLATFORM_TO_RETROARCH: Record<string, string> = {
  SNES: "Nintendo - Super Nintendo Entertainment System",
  NES: "Nintendo - Nintendo Entertainment System",
  "Game Boy": "Nintendo - Game Boy",
  "Game Boy Color": "Nintendo - Game Boy Color",
  "Game Boy Advance": "Nintendo - Game Boy Advance",
  "Nintendo 64": "Nintendo - Nintendo 64",
  "Nintendo DS": "Nintendo - Nintendo DS",
  "Virtual Boy": "Nintendo - Virtual Boy",
  "Family Computer Disk System": "Nintendo - Family Computer Disk System",
  "Pokemon Mini": "Nintendo - Pokemon Mini",
  Genesis: "Sega - Mega Drive - Genesis",
  "Master System": "Sega - Master System - Mark III",
  "Game Gear": "Sega - Game Gear",
  "Sega CD": "Sega - Mega-CD - Sega CD",
  "Sega 32X": "Sega - 32X",
  Saturn: "Sega - Saturn",
  Dreamcast: "Sega - Dreamcast",
  PlayStation: "Sony - PlayStation",
  PSP: "Sony - PlayStation Portable",
  "Atari 2600": "Atari - 2600",
  "Atari 5200": "Atari - 5200",
  "Atari 7800": "Atari - 7800",
  "Atari Lynx": "Atari - Lynx",
  "PC Engine": "NEC - PC Engine - TurboGrafx-16",
  "Neo Geo Pocket": "SNK - Neo Geo Pocket",
  "Neo Geo Pocket Color": "SNK - Neo Geo Pocket Color",
  "Neo Geo CD": "SNK - Neo Geo CD",
  WonderSwan: "Bandai - WonderSwan",
  "WonderSwan Color": "Bandai - WonderSwan Color",
  Arcade: "Arcade",
};

export interface RetroarchCandidatePayload {
  serverId: string;
  gameId: string;
  platform: string;
  type: RetroarchArtworkType;
  title: string;
}

function secret(): string {
  const value = process.env.AUTH_SECRET ?? process.env.NEXTAUTH_SECRET;
  if (!value) throw new Error("AUTH_SECRET is required for cover candidate signing");
  return value;
}

function encode(value: string) {
  return Buffer.from(value, "utf8").toString("base64url");
}

export function signRetroarchCandidate(payload: RetroarchCandidatePayload): string {
  const body = encode(JSON.stringify(payload));
  const signature = createHmac("sha256", secret()).update(body).digest("base64url");
  return `${body}.${signature}`;
}

export function verifyRetroarchCandidate(token: string): RetroarchCandidatePayload | null {
  const [body, signature, extra] = token.split(".");
  if (!body || !signature || extra) return null;
  const expected = createHmac("sha256", secret()).update(body).digest();
  let supplied: Buffer;
  try { supplied = Buffer.from(signature, "base64url"); } catch { return null; }
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Partial<RetroarchCandidatePayload>;
    if (!parsed.serverId || !parsed.gameId || !parsed.platform || !parsed.title || !parsed.type || !(parsed.type in RETROARCH_TYPES)) return null;
    return parsed as RetroarchCandidatePayload;
  } catch { return null; }
}

export function retroarchPlatform(platform: string): string {
  return PLATFORM_TO_RETROARCH[platform] ?? platform;
}

function encodeSegment(value: string) {
  return encodeURIComponent(value).replace(/\(/g, "%28").replace(/\)/g, "%29");
}

export function retroarchCandidateUrl(payload: RetroarchCandidatePayload): string {
  return `https://thumbnails.libretro.com/${encodeSegment(payload.platform)}/${RETROARCH_TYPES[payload.type]}/${encodeSegment(payload.title)}.png`;
}
