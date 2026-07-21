import { NextRequest, NextResponse } from "next/server";
import { verifyBearerToken, unauthorizedResponse } from "@/lib/server-auth";
import { db } from "@/lib/db";
import { games, gameFiles } from "@/lib/db/schema";
import { eq } from "drizzle-orm";

// ── Types ──────────────────────────────────────────────────────────────

interface ImportFile {
  name: string;
  platform: string;
  rom_path: string;
  file_name: string;
  file_size?: number;
  file_hash?: string;
}

interface ImportBody {
  server_id: string;
  files: ImportFile[];
}

// ── Helpers ────────────────────────────────────────────────────────────

function fileSlug(fileName: string, platform: string): string {
  const stem = fileName.replace(/\.[^.]+$/, "").toLowerCase();
  const clean = stem.replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const plat = platform.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return `${plat}-${clean}`.slice(0, 80).replace(/-$/, "");
}

function displayName(file: ImportFile): string {
  return file.name || file.file_name;
}

// ── POST /api/server/import — sc-server auto-imports scanned files ─────

export async function POST(request: NextRequest) {
  const server = await verifyBearerToken(request.headers.get("authorization"));
  if (!server) return unauthorizedResponse();

  let body: ImportBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  if (!body.server_id || !Array.isArray(body.files)) {
    return NextResponse.json({ error: "server_id and files required" }, { status: 400 });
  }

  let imported = 0;
  let skipped = 0;

  for (const file of body.files) {
    if (!file.file_name || !file.platform || !file.rom_path) continue;

    const name = displayName(file);
    const slug = fileSlug(file.file_name, file.platform);

    const existingRows = await db
      .select({ id: games.id, name: games.name, nameSource: games.nameSource })
      .from(games)
      .where(eq(games.slug, slug))
      .limit(1);

    let gameId: string;
    if (existingRows.length > 0) {
      gameId = existingRows[0].id;
      if (existingRows[0].nameSource === "import" && name !== existingRows[0].name) {
        await db.update(games).set({ name }).where(eq(games.id, gameId));
      }
    } else {
      const [created] = await db
        .insert(games)
        .values({ name, slug, platform: file.platform, nameSource: "import" })
        .returning({ id: games.id });
      gameId = created.id;
    }

    try {
      await db.insert(gameFiles).values({
        gameId,
        serverId: server.id,
        romPath: file.rom_path,
        fileName: file.file_name,
        fileSize: file.file_size ?? null,
        fileHash: file.file_hash ?? null,
      });
      imported++;
    } catch {
      skipped++;
    }
  }

  return NextResponse.json({ imported, skipped });
}
