import { NextRequest, NextResponse } from "next/server";
import { verifyBearerToken, unauthorizedResponse } from "@/lib/server-auth";
import { db } from "@/lib/db";
import { serverGames } from "@/lib/db/schema";
import { eq } from "drizzle-orm";

interface SyncGame {
  id: string;
  name: string;
  source_name?: string | null;
  platform: string;
  max_players?: number;
}

// POST /api/server/sync-games — sc-server pushes its game catalog to sc-web.
//
// Full-replace semantics: the server sends its entire current game list.
// All existing rows for this server are deleted, then the new list is inserted.
export async function POST(request: NextRequest) {
  const server = await verifyBearerToken(request.headers.get("authorization"));
  if (!server) return unauthorizedResponse();

  let body: { games?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  if (!Array.isArray(body.games)) {
    return NextResponse.json({ error: "games array required" }, { status: 400 });
  }

  const incoming: SyncGame[] = (body.games as unknown[]).filter(
    (g): g is SyncGame => {
      const item = g as Record<string, unknown>;
      return typeof item.id === "string" && item.id.length > 0 &&
        typeof item.name === "string" && item.name.length > 0;
    },
  );

  // Delete all existing rows for this server
  await db
    .delete(serverGames)
    .where(eq(serverGames.serverId, server.id));

  // Insert incoming games
  let inserted = 0;
  for (const game of incoming) {
    await db
      .insert(serverGames)
      .values({
        serverId: server.id,
        gameId: game.id,
        name: game.name,
        sourceName: game.source_name ?? null,
        platform: game.platform || "Unknown",
        maxPlayers: game.max_players ?? 1,
      })
      .onConflictDoUpdate({
        target: [serverGames.serverId, serverGames.gameId],
        set: {
          name: game.name,
          sourceName: game.source_name ?? null,
          platform: game.platform || "Unknown",
          maxPlayers: game.max_players ?? 1,
          updatedAt: new Date(),
        },
      });
    inserted++;
  }

  return NextResponse.json({ synced: inserted });
}
