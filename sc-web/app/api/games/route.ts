import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { games, gameFiles, serverMembers, pinnedGames } from "@/lib/db/schema";
import { eq, inArray, sql, and, or, ilike, notInArray } from "drizzle-orm";

// ── GET /api/games ─────────────────────────────────────────────────────
//
// Paginated game list scoped to the user's server memberships.
//
// Query params:
//   limit      — rows per page (default 100, max 200)
//   offset     — 0-based offset (default 0)
//   search     — case-insensitive name filter (ILIKE %term%)
//   pins_first — if "true", pinned games are returned first (offset applies
//                only to non-pinned games). Pinned items have "pinned": true.
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
  const pinsFirst = url.searchParams.get("pins_first") === "true";

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

  // ── Pinned-first mode ───────────────────────────────────────────────
  if (pinsFirst) {
    // 1. Fetch pinned games (all of them, respecting search)
    const pinnedConditions = [
      eq(pinnedGames.userId, session.user.id),
      ...conditions,
    ];
    const pinnedRows = await db
      .selectDistinct({
        id: games.id,
        name: games.name,
        platform: games.platform,
        maxPlayers: games.maxPlayers,
        serverId: gameFiles.serverId,
        position: pinnedGames.position,
      })
      .from(pinnedGames)
      .innerJoin(games, eq(pinnedGames.gameId, games.id))
      .innerJoin(gameFiles, eq(games.id, gameFiles.gameId))
      .where(and(...pinnedConditions))
      .orderBy(pinnedGames.position);

    const pinned = pinnedRows.map((r) => ({
      id: r.id,
      name: r.name,
      platform: r.platform,
      maxPlayers: r.maxPlayers,
      serverId: r.serverId,
      pinned: true,
    }));

    const pinnedIds = pinnedRows.map((r) => r.id);

    // 2. Fetch non-pinned games with pagination
    const nonPinnedConditions = [
      ...conditions,
      ...(pinnedIds.length > 0
        ? [notInArray(games.id, pinnedIds)]
        : []),
    ];

    const [{ count }] = await db
      .select({ count: sql<number>`count(DISTINCT ${games.id})` })
      .from(games)
      .innerJoin(gameFiles, eq(games.id, gameFiles.gameId))
      .where(and(...nonPinnedConditions));

    const nonPinnedRows = await db
      .selectDistinct({
        id: games.id,
        name: games.name,
        platform: games.platform,
        maxPlayers: games.maxPlayers,
        serverId: gameFiles.serverId,
      })
      .from(games)
      .innerJoin(gameFiles, eq(games.id, gameFiles.gameId))
      .where(and(...nonPinnedConditions))
      .orderBy(games.name)
      .limit(Math.max(limit - pinned.length, 0))
      .offset(Math.max(offset - pinned.length, 0));

    const nonPinned = nonPinnedRows.map((r) => ({
      id: r.id,
      name: r.name,
      platform: r.platform,
      maxPlayers: r.maxPlayers,
      serverId: r.serverId,
      pinned: false,
    }));

    const all = [...pinned, ...nonPinned];
    return NextResponse.json({ games: all, total: Number(count) + pinned.length });
  }

  // ── Standard paginated mode ─────────────────────────────────────────

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
      serverId: gameFiles.serverId,
    })
    .from(games)
    .innerJoin(gameFiles, eq(games.id, gameFiles.gameId))
    .where(and(...conditions))
    .orderBy(games.name)
    .limit(limit)
    .offset(offset);

  return NextResponse.json({ games: rows, total: Number(count) });
}
