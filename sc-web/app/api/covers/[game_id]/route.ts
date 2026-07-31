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
  const platformName = game.platform;
  const gameName = game.name;
  const url = `${THUMBNAIL_BASE}/${platformName}/Named_Boxarts/${encodeGameName(gameName)}.png`;

  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(15000) });

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
