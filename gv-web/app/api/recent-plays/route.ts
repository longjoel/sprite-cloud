import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { recentPlays, games, gameFiles, serverMembers } from "@/lib/db/schema";
import { eq, and, inArray, sql } from "drizzle-orm";

// ── GET /api/recent-plays ───────────────────────────────────────────────
//
// Paginated list of the user's recently played games (distinct, most recent first).
//
// Query params: limit (default 50), offset (default 0)

export async function GET(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "sign in first" }, { status: 401 });
  }

  const url = new URL(request.url);
  const limit = Math.min(Math.max(parseInt(url.searchParams.get("limit") || "50"), 1), 200);
  const offset = Math.max(parseInt(url.searchParams.get("offset") || "0"), 0);

  // Get user's server memberships
  const memberships = await db
    .select({ serverId: serverMembers.serverId })
    .from(serverMembers)
    .where(eq(serverMembers.userId, session.user.id));
  const serverIds = memberships.map((m) => m.serverId);

  // Count distinct games
  const conditions = [eq(recentPlays.userId, session.user.id)];
  if (serverIds.length > 0) {
    conditions.push(inArray(gameFiles.serverId, serverIds));
  }
  const [{ count }] = await db
    .select({ count: sql<number>`count(DISTINCT ${games.id})` })
    .from(recentPlays)
    .innerJoin(games, eq(recentPlays.gameId, games.id))
    .innerJoin(gameFiles, eq(games.id, gameFiles.gameId))
    .where(and(...conditions));

  if (Number(count) === 0) {
    return NextResponse.json({ games: [], total: 0 });
  }

  // Fetch most recent per distinct game
  const rows = await db
    .selectDistinctOn([recentPlays.gameId], {
      id: games.id,
      name: games.name,
      platform: games.platform,
      maxPlayers: games.maxPlayers,
    })
    .from(recentPlays)
    .innerJoin(games, eq(recentPlays.gameId, games.id))
    .innerJoin(gameFiles, eq(games.id, gameFiles.gameId))
    .where(and(...conditions))
    .orderBy(recentPlays.gameId, recentPlays.playedAt)
    .limit(limit)
    .offset(offset);

  // Re-sort client-side by playedAt desc (DISTINCT ON requires the first ORDER BY to match)
  // We'll just fetch the raw played_at and sort
  const withTime = await db
    .select({
      id: games.id,
      name: games.name,
      platform: games.platform,
      maxPlayers: games.maxPlayers,
      playedAt: recentPlays.playedAt,
    })
    .from(recentPlays)
    .innerJoin(games, eq(recentPlays.gameId, games.id))
    .innerJoin(gameFiles, eq(games.id, gameFiles.gameId))
    .where(and(...conditions))
    .orderBy(recentPlays.playedAt)
    .limit(limit)
    .offset(offset);

  return NextResponse.json({ games: withTime.map(({ playedAt, ...rest }) => rest), total: Number(count) });
}

// ── POST /api/recent-plays ──────────────────────────────────────────────
//
// Record a game launch. Called by the client when a game starts.
// Body: { gameId: string }

export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "sign in first" }, { status: 401 });
  }

  let body: { gameId?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const gameId = body.gameId?.trim();
  if (!gameId) {
    return NextResponse.json({ error: "gameId is required" }, { status: 400 });
  }

  await db.insert(recentPlays).values({
    userId: session.user.id,
    gameId,
  });

  return NextResponse.json({ ok: true });
}
