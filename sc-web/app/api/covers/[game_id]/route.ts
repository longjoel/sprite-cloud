import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { serverGames } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { auth } from "@/lib/auth";
import { mkdir, writeFile } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";

const THUMBNAIL_BASE = "https://thumbnails.libretro.com";
const CACHE_DIR = join(process.cwd(), "public", "covers");
const MAX_SIZE = 5 * 1024 * 1024; // 5 MiB

/// Map sc-server platform short names to RetroArch thumbnail folder names.
/// RetroArch uses No-Intro-style folder names: "Nintendo - System Name".
const PLATFORM_TO_RETROARCH: Record<string, string> = {
  "SNES": "Nintendo - Super Nintendo Entertainment System",
  "NES": "Nintendo - Nintendo Entertainment System",
  "Game Boy": "Nintendo - Game Boy",
  "Game Boy Color": "Nintendo - Game Boy Color",
  "Game Boy Advance": "Nintendo - Game Boy Advance",
  "Nintendo 64": "Nintendo - Nintendo 64",
  "Nintendo DS": "Nintendo - Nintendo DS",
  "Virtual Boy": "Nintendo - Virtual Boy",
  "Family Computer Disk System": "Nintendo - Family Computer Disk System",
  "Pokemon Mini": "Nintendo - Pokemon Mini",
  "Genesis": "Sega - Mega Drive - Genesis",
  "Master System": "Sega - Master System - Mark III",
  "Game Gear": "Sega - Game Gear",
  "Sega CD": "Sega - Mega-CD - Sega CD",
  "Sega 32X": "Sega - 32X",
  "Saturn": "Sega - Saturn",
  "Dreamcast": "Sega - Dreamcast",
  "PlayStation": "Sony - PlayStation",
  "PSP": "Sony - PlayStation Portable",
  "Atari 2600": "Atari - 2600",
  "Atari 5200": "Atari - 5200",
  "Atari 7800": "Atari - 7800",
  "Atari Lynx": "Atari - Lynx",
  "PC Engine": "NEC - PC Engine - TurboGrafx 16",
  "Neo Geo Pocket": "SNK - Neo Geo Pocket",
  "Neo Geo Pocket Color": "SNK - Neo Geo Pocket Color",
  "Neo Geo CD": "SNK - Neo Geo CD",
  "WonderSwan": "Bandai - WonderSwan",
  "WonderSwan Color": "Bandai - WonderSwan Color",
  "Arcade": "Arcade",
};

function encodeGameName(name: string): string {
  return name
    .replace(/ /g, "%20")
    .replace(/\(/g, "%28")
    .replace(/\)/g, "%29")
    .replace(/&/g, "%26")
    .replace(/'/g, "%27")
    .replace(/#/g, "%23")
    .replace(/\+/g, "%2B")
    .replace(/,/g, "%2C")
    .replace(/:/g, "%3A")
    .replace(/!/g, "%21");
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ game_id: string }> }
) {
  const { game_id } = await params;

  const session = await auth();
  if (!session?.user?.id) {
    return new NextResponse("sign in first", { status: 401 });
  }

  // Look up the game in the catalog to get platform + name
  const [game] = await db
    .select({ name: serverGames.name, platform: serverGames.platform })
    .from(serverGames)
    .where(eq(serverGames.gameId, game_id))
    .limit(1);

  console.log(`[covers] game_id=${game_id} found=${!!game} name=${game?.name} platform=${game?.platform}`);

  if (!game) {
    return new NextResponse("game not found", { status: 404 });
  }

  // Check local cache
  const cachePath = join(CACHE_DIR, `${game_id}.png`);
  if (existsSync(cachePath)) {
    const { readFile } = await import("fs/promises");
    const data = await readFile(cachePath);
    return new NextResponse(data, {
      headers: {
        "Content-Type": "image/png",
        "Cache-Control": "public, max-age=86400, immutable",
      },
    });
  }

  // Fetch from RetroArch thumbnail server
  const retroarchPlatform = PLATFORM_TO_RETROARCH[game.platform] ?? game.platform;
  const thumbnailUrl = `${THUMBNAIL_BASE}/${encodeURIComponent(retroarchPlatform)}/Named_Boxarts/${encodeGameName(game.name)}.png`;
  console.log(`[covers] fetching: ${thumbnailUrl}`);

  try {
    const resp = await fetch(thumbnailUrl, { signal: AbortSignal.timeout(15000) });

    if (!resp.ok) {
      return new NextResponse("no cover available", { status: 404 });
    }

    const contentLength = resp.headers.get("content-length");
    if (contentLength && parseInt(contentLength) > MAX_SIZE) {
      return new NextResponse("cover too large", { status: 404 });
    }

    const buf = await resp.arrayBuffer();
    if (buf.byteLength > MAX_SIZE) {
      return new NextResponse("cover too large", { status: 404 });
    }

    const bytes = new Uint8Array(buf);

    // Validate PNG magic bytes
    const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    if (bytes.length < 8 || !PNG_MAGIC.every((b, i) => bytes[i] === b)) {
      return new NextResponse("invalid image", { status: 404 });
    }

    // Cache locally
    try {
      await mkdir(CACHE_DIR, { recursive: true });
      await writeFile(cachePath, bytes);
    } catch {
      // Cache write failure is non-fatal
    }

    return new NextResponse(bytes, {
      headers: {
        "Content-Type": "image/png",
        "Cache-Control": "public, max-age=86400, immutable",
      },
    });
  } catch {
    return new NextResponse("cover unavailable", { status: 404 });
  }
}
