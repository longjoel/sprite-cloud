import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { serverGames, serverMembers } from "@/lib/db/schema";
import { and, eq } from "drizzle-orm";
import { auth } from "@/lib/auth";
import { mkdir, rename, writeFile } from "fs/promises";
import { existsSync } from "fs";
import { createHash, randomUUID } from "crypto";
import { join } from "path";

export const runtime = "nodejs";

const THUMBNAIL_BASE = "https://thumbnails.libretro.com";
const CACHE_DIR = process.env.GV_COVERS_DIR ?? join(process.cwd(), ".cache", "covers");
const MAX_SIZE = 5 * 1024 * 1024;
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

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

function cachePath(serverId: string, gameId: string, lookupName: string, platform: string) {
  const key = createHash("sha256")
    .update(serverId)
    .update("\0")
    .update(gameId)
    .update("\0")
    .update(platform)
    .update("\0")
    .update(lookupName)
    .digest("hex");
  return join(CACHE_DIR, `${key}.png`);
}

function encodeGameName(name: string): string {
  // encodeURIComponent deliberately leaves parentheses unescaped; RetroArch's
  // canonical filenames frequently use them for region markers.
  return encodeURIComponent(name)
    .replace(/\(/g, "%28")
    .replace(/\)/g, "%29");
}

async function readBoundedPng(response: Response): Promise<Uint8Array | null> {
  const contentLength = response.headers.get("content-length");
  if (contentLength && Number(contentLength) > MAX_SIZE) return null;
  if (response.headers.get("content-type") && !response.headers.get("content-type")?.startsWith("image/png")) {
    return null;
  }
  if (!response.body) return null;

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_SIZE) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes.length >= PNG_MAGIC.length && PNG_MAGIC.every((byte, index) => bytes[index] === byte)
    ? bytes
    : null;
}

function imageResponse(bytes: Uint8Array) {
  // Copy into an exact ArrayBuffer: Node Buffers may be a view into a larger pool.
  const body = new Uint8Array(bytes).buffer;
  return new NextResponse(body, {
    headers: {
      "Content-Type": "image/png",
      // Covers are authorization-scoped. Do not let a browser or shared proxy replay one after logout.
      "Cache-Control": "private, no-store",
    },
  });
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ server_id: string; game_id: string }> },
) {
  const session = await auth();
  if (!session?.user?.id) return new NextResponse("sign in first", { status: 401 });

  const { server_id: serverId, game_id: gameId } = await params;
  const [game] = await db
    .select({
      name: serverGames.name,
      sourceName: serverGames.sourceName,
      thumbnailName: serverGames.thumbnailName,
      platform: serverGames.platform,
    })
    .from(serverGames)
    .innerJoin(
      serverMembers,
      and(
        eq(serverMembers.serverId, serverGames.serverId),
        eq(serverMembers.userId, session.user.id),
      ),
    )
    .where(and(eq(serverGames.serverId, serverId), eq(serverGames.gameId, gameId)))
    .limit(1);

  if (!game) return new NextResponse("game not found", { status: 404 });

  // Only a paired server can supply thumbnailName. UI titles remain cosmetic.
  const lookupName = game.thumbnailName ?? game.sourceName ?? game.name;
  const retroarchPlatform = PLATFORM_TO_RETROARCH[game.platform] ?? game.platform;
  const path = cachePath(serverId, gameId, lookupName, retroarchPlatform);
  if (existsSync(path)) {
    const { readFile } = await import("fs/promises");
    return imageResponse(await readFile(path));
  }

  const thumbnailUrl = `${THUMBNAIL_BASE}/${encodeURIComponent(retroarchPlatform)}/Named_Boxarts/${encodeGameName(lookupName)}.png`;
  try {
    const response = await fetch(thumbnailUrl, { signal: AbortSignal.timeout(15_000) });
    if (!response.ok) return new NextResponse("no cover available", { status: 404 });
    const bytes = await readBoundedPng(response);
    if (!bytes) return new NextResponse("invalid cover", { status: 404 });

    await mkdir(CACHE_DIR, { recursive: true });
    const temporaryPath = `${path}.${randomUUID()}.partial`;
    await writeFile(temporaryPath, bytes);
    await rename(temporaryPath, path);
    return imageResponse(bytes);
  } catch {
    return new NextResponse("cover unavailable", { status: 404 });
  }
}
