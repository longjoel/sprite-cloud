import { NextRequest, NextResponse } from "next/server";
import { verifyBearerToken, unauthorizedResponse } from "@/lib/server-auth";
import { db } from "@/lib/db";
import { serverGames } from "@/lib/db/schema";
import { and, eq, inArray, sql } from "drizzle-orm";

interface SyncGame {
  id: string;
  name: string;
  platform: string;
  max_players?: number;
}

interface SyncBody {
  games: SyncGame[];
}

// POST /api/server/sync-games — sc-server pushes its game catalog to sc-web.
//
// Full-replace semantics: the server sends its entire current game list.
// Existing rows for this server not in the new list are deleted.
// New/updated rows are upserted.
export async function POST(request: NextRequest) {
  const server = await verifyBearerToken(request.headers.get("authorization"));
  if (!server) return unauthorizedResponse();

  let body: SyncBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  if (!Array.isArray(body.games)) {
    return NextResponse.json({ error: "games array required" }, { status: 400 });
  }

  const incoming = body.games.filter(
    (g): g is SyncGame =>
      typeof g.id === "string" && g.id.length > 0 &&
      typeof g.name === "string" && g.name.length > 0
  );

  const incomingIds = incoming.map((g) => g.id);

  // Delete games no longer in the server's library
  if (incomingIds.length > 0) {
    await db
      .delete(serverGames)
      .where(
        and(
          eq(serverGames.serverId, server.id),
          incomingIds.length > 0
            ? sql`${serverGames.gameId} NOT IN (${sql.join(incomingIds.map((id) => sql`${id}`))})`
            : undefined,
        ),
      );
  } else {
    // Empty list — clear all games for this server
    await db
      .delete(serverGames)
      .where(eq(serverGames.serverId, server.id));
  }

  // Upsert incoming games
  let upserted = 0;
  for (const game of incoming) {
    await db
      .insert(serverGames)
      .values({
        serverId: server.id,
        gameId: game.id,
        name: game.name,
        platform: game.platform || "Unknown",
        maxPlayers: game.max_players ?? 1,
      })
      .onConflictDoUpdate({
        target: [serverGames.serverId, serverGames.gameId],
        set: {
          name: game.name,
          platform: game.platform || "Unknown",
          maxPlayers: game.max_players ?? 1,
          updatedAt: new Date(),
        },
      });
    upserted++;
  }

  return NextResponse.json({ synced: upserted, removed: 0 });
}
