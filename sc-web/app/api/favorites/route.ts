import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { favorites, games, gameFiles, serverMembers } from "@/lib/db/schema";
import { eq, and, inArray, sql, ilike } from "drizzle-orm";

// ── GET /api/favorites ──────────────────────────────────────────────────
//
// Paginated list of the user's favorited games.
//
// Query params: limit (default 100), offset (default 0), search (game name)

export async function GET(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "sign in first" }, { status: 401 });
  }

  const url = new URL(request.url);
  const limit = Math.min(Math.max(parseInt(url.searchParams.get("limit") || "100"), 1), 200);
  const offset = Math.max(parseInt(url.searchParams.get("offset") || "0"), 0);
  const search = (url.searchParams.get("search") || "").trim();

  // Get user's server memberships so we only show games on their servers
  const memberships = await db
    .select({ serverId: serverMembers.serverId })
    .from(serverMembers)
    .where(eq(serverMembers.userId, session.user.id));
  const serverIds = memberships.map((m) => m.serverId);

  // Count
  const conditions = [eq(favorites.userId, session.user.id)];
  if (serverIds.length > 0) {
    conditions.push(inArray(gameFiles.serverId, serverIds));
  }
  if (search) {
    conditions.push(ilike(games.name, `%${search}%`));
  }
  const [{ count }] = await db
    .select({ count: sql<number>`count(DISTINCT ${games.id})` })
    .from(favorites)
    .innerJoin(games, eq(favorites.gameId, games.id))
    .innerJoin(gameFiles, eq(games.id, gameFiles.gameId))
    .where(and(...conditions));

  if (Number(count) === 0) {
    return NextResponse.json({ games: [], total: 0 });
  }

  // Fetch page
  const rows = await db
    .selectDistinct({
      id: games.id,
      name: games.name,
      platform: games.platform,
      maxPlayers: games.maxPlayers,
    })
    .from(favorites)
    .innerJoin(games, eq(favorites.gameId, games.id))
    .innerJoin(gameFiles, eq(games.id, gameFiles.gameId))
    .where(and(...conditions))
    .orderBy(games.name)
    .limit(limit)
    .offset(offset);

  return NextResponse.json({ games: rows, total: Number(count) });
}

// ── POST /api/favorites ─────────────────────────────────────────────────
//
// Body: { gameId: string }
// Toggles favorite: if already favorited → removes it. Otherwise → adds it.
// Returns { favorited: boolean }

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

  // Check if already favorited
  const [existing] = await db
    .select()
    .from(favorites)
    .where(and(
      eq(favorites.userId, session.user.id),
      eq(favorites.gameId, gameId),
    ))
    .limit(1);

  if (existing) {
    // Remove favorite
    await db
      .delete(favorites)
      .where(and(
        eq(favorites.userId, session.user.id),
        eq(favorites.gameId, gameId),
      ));
    return NextResponse.json({ favorited: false });
  }

  // Add favorite
  await db.insert(favorites).values({
    userId: session.user.id,
    gameId,
  });

  return NextResponse.json({ favorited: true });
}
