import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { commands, games, gameFiles } from "@/lib/db/schema";
import { verifyBearerToken } from "@/lib/server-auth";
import { eq, and } from "drizzle-orm";
import { STATUS_COMPLETED, STATUS_LEASED, CMD_SCAN_PATHS } from "@/lib/constants";

// ── Types ──────────────────────────────────────────────────────────────

interface ScanMatch {
  file: {
    name: string;
    relative_path: string;
    size_bytes: number;
    crc?: string;
    sha256?: string;
    platform?: string;
  };
  match?: {
    name: string;
    game_name?: string;
  } | null;
}

interface ScanResult {
  matches: ScanMatch[];
}

// ── Helpers ────────────────────────────────────────────────────────────

/** Stable slug from filename (not display name) — re-scans always match. */
function fileSlug(fileName: string, platform: string): string {
  const stem = fileName.replace(/\.[^.]+$/, "").toLowerCase();
  const clean = stem.replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const plat = platform.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return `${clean}-${plat}`;
}

/** Display name: DAT match > filename without extension. */
function displayName(file: ScanMatch["file"], match?: ScanMatch["match"] | null): string {
  if (match?.name) return match.name;
  const stem = file.name.replace(/\.[^.]+$/, "");
  return stem.replace(/[_-]+/g, " ").trim() || file.name;
}

/** Detect platform from scan result. */
function detectPlatform(file: ScanMatch["file"]): string {
  if (file.platform) return file.platform;
  const ext = file.name.split(".").pop()?.toLowerCase() || "";
  const map: Record<string, string> = {
    nes: "nes", sfc: "snes", smc: "snes",
    gb: "gb", gbc: "gbc", gba: "gba",
    gen: "genesis", md: "genesis",
    n64: "n64", z64: "n64",
    smd: "genesis", gg: "gg",
  };
  return map[ext] || "unknown";
}

// ── POST /api/server/result ────────────────────────────────────────────

export async function POST(request: NextRequest) {
  const server = await verifyBearerToken(request.headers.get("authorization"));
  if (!server) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: { command_id?: string; lease_token?: string; result?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  if (!body.command_id || !body.lease_token || body.result === undefined) {
    return NextResponse.json(
      { error: "command_id, lease_token, and result required" },
      { status: 400 },
    );
  }

  const [updated] = await db
    .update(commands)
    .set({ result: body.result, status: STATUS_COMPLETED, completedAt: new Date(), lastError: null })
    .where(
      and(
        eq(commands.id, body.command_id),
        eq(commands.serverId, server.id),
        eq(commands.status, STATUS_LEASED),
        eq(commands.leaseToken, body.lease_token),
      ),
    )
    .returning({ id: commands.id, type: commands.type });

  if (!updated) {
    return NextResponse.json({ error: "command not found" }, { status: 404 });
  }

  let imported = 0;
  let skipped = 0;

  if (updated.type === CMD_SCAN_PATHS) {
    const result = body.result as ScanResult;
    if (result?.matches && Array.isArray(result.matches)) {
      for (const m of result.matches) {
        const file = m.file;
        if (!file?.name || !file?.relative_path) continue;

        const name = displayName(file, m.match);
        const platform = detectPlatform(file);
        const slug = fileSlug(file.name, platform);

        // Look up by filename-based slug (stable across re-scans)
        const existingRows = await db
          .select({ id: games.id, name: games.name, nameSource: games.nameSource })
          .from(games)
          .where(eq(games.slug, slug))
          .limit(1);

        let gameId: string;
        if (existingRows.length > 0) {
          gameId = existingRows[0].id;
          // Update name if source is 'import' and DAT has a better match
          if (existingRows[0].nameSource === "import" && name !== existingRows[0].name) {
            await db.update(games).set({ name }).where(eq(games.id, gameId));
          }
        } else {
          const [created] = await db
            .insert(games)
            .values({ name, slug, platform, nameSource: "import" })
            .returning({ id: games.id });
          gameId = created.id;
        }

        try {
          await db.insert(gameFiles).values({
            gameId,
            serverId: server.id,
            romPath: file.relative_path,
            fileName: file.name,
            fileSize: file.size_bytes ?? null,
            fileHash: file.sha256 ?? null,
          });
          imported++;
        } catch {
          skipped++;
        }
      }
    }
  }

  const response: Record<string, unknown> = { ok: true };
  if (imported > 0 || skipped > 0) {
    response.imported = imported;
    response.skipped = skipped;
  }
  return NextResponse.json(response);
}
