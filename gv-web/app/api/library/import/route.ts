import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { games, gameFiles, serverMembers } from "@/lib/db/schema";
import { and, eq } from "drizzle-orm";

// ── Types ──────────────────────────────────────────────────────────────

interface ImportFile {
  name: string;       // display name (DAT match or filename)
  platform: string;
  rom_path: string;
  file_name: string;  // original filename for stable slug
  file_size?: number;
  file_hash?: string;
  dat_name?: string;  // DAT canonical name (if matched)
}

interface ImportBody {
  server_id: string;
  files: ImportFile[];
}

// ── Helpers ────────────────────────────────────────────────────────────

/** Stable slug from filename — re-scans always match the same game row. */
function fileSlug(fileName: string, platform: string): string {
  const stem = fileName.replace(/\.[^.]+$/, "").toLowerCase();
  const clean = stem.replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const plat = platform.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return `${clean}-${plat}`;
}

/** Display name: DAT match > filename without extension. */
function displayName(file: ImportFile): string {
  if (file.dat_name) return file.dat_name;
  const stem = file.file_name.replace(/\.[^.]+$/, "");
  return stem.replace(/[_-]+/g, " ").trim() || file.file_name;
}

// ── POST /api/library/import ───────────────────────────────────────────

export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "sign in first" }, { status: 401 });
  }

  let body: ImportBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  if (!body.server_id || !Array.isArray(body.files) || body.files.length === 0) {
    return NextResponse.json(
      { error: "server_id and files[] required" },
      { status: 400 },
    );
  }

  // Verify admin on this server
  const [membership] = await db
    .select({ id: serverMembers.id })
    .from(serverMembers)
    .where(
      and(
        eq(serverMembers.serverId, body.server_id),
        eq(serverMembers.userId, session.user.id),
        eq(serverMembers.role, "admin"),
      ),
    )
    .limit(1);

  if (!membership) {
    return NextResponse.json(
      { error: "server not found or not authorized" },
      { status: 403 },
    );
  }

  let imported = 0;
  let skipped = 0;

  for (const file of body.files) {
    if (!file.file_name || !file.platform || !file.rom_path) continue;

    const name = displayName(file);
    const slug = fileSlug(file.file_name, file.platform);

    // Look up by filename-based slug (stable across re-scans)
    const existingRows = await db
      .select({ id: games.id, name: games.name, nameSource: games.nameSource })
      .from(games)
      .where(eq(games.slug, slug))
      .limit(1);

    let gameId: string;
    if (existingRows.length > 0) {
      gameId = existingRows[0].id;
      // Update name if source is 'import' and we have a better name
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
        serverId: body.server_id,
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
