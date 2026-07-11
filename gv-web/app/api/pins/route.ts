import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { pinnedGames, games, gameFiles, serverMembers } from "@/lib/db/schema";
import { eq, and, inArray, sql } from "drizzle-orm";

const MAX_PINS = 20;

// ── GET /api/pins ────────────────────────────────────────────────────────
//
// Returns the user's pinned game IDs (ordered by position).
// Query: ?ids_only=true returns just IDs; otherwise returns full game rows.

export async function GET(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "sign in first" }, { status: 401 });
  }

  const url = new URL(request.url);
  const idsOnly = url.searchParams.get("ids_only") === "true";

  if (idsOnly) {
    const rows = await db
      .select({ gameId: pinnedGames.gameId })
      .from(pinnedGames)
      .where(eq(pinnedGames.userId, session.user.id))
      .orderBy(pinnedGames.position);

    return NextResponse.json({ ids: rows.map((r) => r.gameId) });
  }

  // Full rows — join with games
  const memberships = await db
    .select({ serverId: serverMembers.serverId })
    .from(serverMembers)
    .where(eq(serverMembers.userId, session.user.id));
  const serverIds = memberships.map((m) => m.serverId);

  if (serverIds.length === 0) {
    return NextResponse.json({ games: [] });
  }

  const rows = await db
    .selectDistinct({
      id: games.id,
      name: games.name,
      platform: games.platform,
      maxPlayers: games.maxPlayers,
      position: pinnedGames.position,
    })
    .from(pinnedGames)
    .innerJoin(games, eq(pinnedGames.gameId, games.id))
    .innerJoin(gameFiles, eq(games.id, gameFiles.gameId))
    .where(and(
      eq(pinnedGames.userId, session.user.id),
      inArray(gameFiles.serverId, serverIds),
    ))
    .orderBy(pinnedGames.position);

  return NextResponse.json({ games: rows });
}

// ── POST /api/pins ───────────────────────────────────────────────────────
//
// Body: { gameId: string }
// Toggles pin: if already pinned → unpins. Otherwise → pins (max 20).
// Returns { pinned: boolean, pinCount: number }

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

  // Check if already pinned
  const [existing] = await db
    .select()
    .from(pinnedGames)
    .where(and(
      eq(pinnedGames.userId, session.user.id),
      eq(pinnedGames.gameId, gameId),
    ))
    .limit(1);

  if (existing) {
    // Remove pin
    await db
      .delete(pinnedGames)
      .where(and(
        eq(pinnedGames.userId, session.user.id),
        eq(pinnedGames.gameId, gameId),
      ));
    const [{ count }] = await db
      .select({ count: sql<number>`count(*)` })
      .from(pinnedGames)
      .where(eq(pinnedGames.userId, session.user.id));
    return NextResponse.json({ pinned: false, pinCount: Number(count) });
  }

  // Check limit
  const [{ count }] = await db
    .select({ count: sql<number>`count(*)` })
    .from(pinnedGames)
    .where(eq(pinnedGames.userId, session.user.id));

  if (Number(count) >= MAX_PINS) {
    return NextResponse.json({ error: `Max ${MAX_PINS} pins allowed` }, { status: 400 });
  }

  // Add pin at end
  await db.insert(pinnedGames).values({
    userId: session.user.id,
    gameId,
    position: Number(count), // 0-based position
  });

  return NextResponse.json({ pinned: true, pinCount: Number(count) + 1 });
}
