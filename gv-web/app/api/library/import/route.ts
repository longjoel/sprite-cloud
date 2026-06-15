import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { games, gameFiles, serverMembers } from "@/lib/db/schema";
import { and, eq } from "drizzle-orm";

// ── Types ──────────────────────────────────────────────────────────────

interface ImportFile {
  name: string; // display name (DAT match or filename)
  platform: string;
  rom_path: string; // relative path within a ROM root
  file_name: string;
  file_size?: number;
  file_hash?: string;
}

interface ImportBody {
  server_id: string;
  files: ImportFile[];
}

// ── Helpers ────────────────────────────────────────────────────────────

function slugify(name: string, platform: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  const plat = platform
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return `${base}-${plat}`;
}

// ── POST /api/library/import ───────────────────────────────────────────

/**
 * Accepts scan results from the settings page and creates `games` +
 * `game_files` rows so they appear in the library on the home page.
 *
 * Deduplication: games are keyed by name + platform (slug). If a game
 * already exists it is reused. game_files are keyed by (server_id, rom_path)
 * — inserting the same file twice is a no-op.
 */
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
    if (!file.name || !file.platform || !file.rom_path || !file.file_name) {
      continue; // skip malformed entries
    }

    const slug = slugify(file.name, file.platform);

    // Upsert game — find by slug or create
    let gameRows = await db
      .select({ id: games.id })
      .from(games)
      .where(eq(games.slug, slug))
      .limit(1);

    let gameId: string;

    if (gameRows.length > 0) {
      gameId = gameRows[0].id;
    } else {
      const [created] = await db
        .insert(games)
        .values({
          name: file.name,
          slug,
          platform: file.platform,
        })
        .returning({ id: games.id });
      gameId = created.id;
    }

    // Insert game_file (skip if already exists for this server+path)
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
      // unique constraint violation → already imported, skip
      skipped++;
    }
  }

  return NextResponse.json({ imported, skipped });
}
