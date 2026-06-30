import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { games, gameFiles, serverMembers } from "@/lib/db/schema";
import { eq, inArray, sql, and, or, ilike } from "drizzle-orm";

// ── GET /api/games ─────────────────────────────────────────────────────
//
// Paginated game list scoped to the user's server memberships.
//
// Query params:
//   limit  — rows per page (default 100, max 200)
//   offset — 0-based offset (default 0)
//   search — case-insensitive name filter (ILIKE %term%)
//
// Response: { games: GameEntry[], total: number }

export async function GET(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "sign in first" }, { status: 401 });
  }

  const url = new URL(request.url);
  const limit = Math.min(Math.max(parseInt(url.searchParams.get("limit") || "100"), 1), 200);
  const offset = Math.max(parseInt(url.searchParams.get("offset") || "0"), 0);
  const search = (url.searchParams.get("search") || "").trim();

  // Resolve user's server memberships
  const memberships = await db
    .select({ serverId: serverMembers.serverId })
    .from(serverMembers)
    .where(eq(serverMembers.userId, session.user.id));

  const serverIds = memberships.map((m) => m.serverId);
  if (serverIds.length === 0) {
    return NextResponse.json({ games: [], total: 0 });
  }

  // Build conditions
  const conditions = [inArray(gameFiles.serverId, serverIds)];
  if (search) {
    conditions.push(ilike(games.name, `%${search}%`));
  }

  // Count total
  const [{ count }] = await db
    .select({ count: sql<number>`count(DISTINCT ${games.id})` })
    .from(games)
    .innerJoin(gameFiles, eq(games.id, gameFiles.gameId))
    .where(and(...conditions));

  // Fetch page
  const rows = await db
    .selectDistinct({
      id: games.id,
      name: games.name,
      platform: games.platform,
      maxPlayers: games.maxPlayers,
    })
    .from(games)
    .innerJoin(gameFiles, eq(games.id, gameFiles.gameId))
    .where(and(...conditions))
    .orderBy(games.name)
    .limit(limit)
    .offset(offset);

  return NextResponse.json({ games: rows, total: Number(count) });
}
