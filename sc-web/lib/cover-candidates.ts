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
  "PC Engine": "NEC - PC Engine - TurboGrafx 16",
  "Neo Geo Pocket": "SNK - Neo Geo Pocket",
  "Neo Geo Pocket Color": "SNK - Neo Geo Pocket Color",
  "Neo Geo CD": "SNK - Neo Geo CD",
  WonderSwan: "Bandai - WonderSwan",
  "WonderSwan Color": "Bandai - WonderSwan Color",
  Arcade: "FBNeo - Arcade Games",
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
    if (!parsed.serverId || !parsed.gameId || !parsed.platform || !parsed.title || !parsed.type || !Object.hasOwn(RETROARCH_TYPES, parsed.type)) return null;
    return parsed as RetroarchCandidatePayload;
  } catch { return null; }
}

export function retroarchPlatform(platform: string): string | null {
  return Object.hasOwn(PLATFORM_TO_RETROARCH, platform) ? PLATFORM_TO_RETROARCH[platform] : null;
}

function encodeSegment(value: string) {
  return encodeURIComponent(value).replace(/\(/g, "%28").replace(/\)/g, "%29");
}

const RETROARCH_INDEX_MAX_BYTES = 6 * 1024 * 1024;
const RETROARCH_INDEX_TTL_MS = 15 * 60 * 1000;
const RETROARCH_INDEX_CACHE_MAX_ENTRIES = 12;
const retroarchIndexCache = new Map<string, { expiresAt: number; titles: string[] }>();

function retroarchDirectoryUrl(platform: string, type: RetroarchArtworkType): string {
  return `https://thumbnails.libretro.com/${encodeSegment(platform)}/${RETROARCH_TYPES[type]}/`;
}

async function readBoundedText(response: Response): Promise<string> {
  const declaredLength = Number(response.headers.get("content-length") ?? "0");
  if (declaredLength > RETROARCH_INDEX_MAX_BYTES) throw new Error("RetroArch artwork index is too large");
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > RETROARCH_INDEX_MAX_BYTES) throw new Error("RetroArch artwork index is too large");
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(bytes);
}

function decodeHtmlEntities(value: string): string {
  let decoded = value;
  for (let pass = 0; pass < 2; pass += 1) {
    const next = decoded.replace(/&(#x[\da-f]+|#\d+|amp|quot|apos|lt|gt);/gi, (entity, code: string) => {
      const normalized = code.toLowerCase();
      if (normalized === "amp") return "&";
      if (normalized === "quot") return '"';
      if (normalized === "apos") return "'";
      if (normalized === "lt") return "<";
      if (normalized === "gt") return ">";
      const point = normalized.startsWith("#x")
        ? Number.parseInt(normalized.slice(2), 16)
        : Number.parseInt(normalized.slice(1), 10);
      return Number.isSafeInteger(point) && point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : entity;
    });
    if (next === decoded) break;
    decoded = next;
  }
  return decoded;
}

function parseRetroarchIndex(html: string): string[] {
  const titles: string[] = [];
  const seen = new Set<string>();
  for (const match of html.matchAll(/href="([^"?#]+\.png)"/gi)) {
    let filename: string;
    try { filename = decodeURIComponent(decodeHtmlEntities(match[1])); } catch { continue; }
    if (filename.includes("/") || filename.includes("\\") || filename.includes("\0")) continue;
    const title = filename.slice(0, -4);
    if (title && !seen.has(title)) { seen.add(title); titles.push(title); }
  }
  return titles;
}

export async function searchRetroarchCandidates(platform: string, type: RetroarchArtworkType, query: string): Promise<string[]> {
  const directoryUrl = retroarchDirectoryUrl(platform, type);
  const now = Date.now();
  for (const [key, value] of retroarchIndexCache) {
    if (value.expiresAt <= now) retroarchIndexCache.delete(key);
  }
  let titles = retroarchIndexCache.get(directoryUrl);
  if (!titles || titles.expiresAt <= now) {
    const response = await fetch(directoryUrl, {
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
      headers: { Accept: "text/html" },
    });
    if (!response.ok || !(response.headers.get("content-type") ?? "").toLowerCase().startsWith("text/html")) {
      throw new Error("RetroArch artwork index is unavailable");
    }
    titles = { expiresAt: now + RETROARCH_INDEX_TTL_MS, titles: parseRetroarchIndex(await readBoundedText(response)) };
    if (retroarchIndexCache.size >= RETROARCH_INDEX_CACHE_MAX_ENTRIES) {
      const oldest = retroarchIndexCache.keys().next().value;
      if (oldest) retroarchIndexCache.delete(oldest);
    }
    retroarchIndexCache.set(directoryUrl, titles);
  }
  const normalized = query.trim().toLocaleLowerCase();
  return titles.titles.filter((title) => title.toLocaleLowerCase().includes(normalized)).slice(0, 24);
}

export function retroarchCandidateUrl(payload: RetroarchCandidatePayload): string {
  return `https://thumbnails.libretro.com/${encodeSegment(payload.platform)}/${RETROARCH_TYPES[payload.type]}/${encodeSegment(payload.title)}.png`;
}
