import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { serverGames, serverMembers } from "@/lib/db/schema";
import { and, eq, ilike, sql, inArray } from "drizzle-orm";

// ── GET /api/games ─────────────────────────────────────────────────────
//
// Queries the server-pushed game catalog cached on sc-web.
// Scoped to servers the authenticated user is a member of.
//
// Query params:
//   limit      — rows per page (default 100, max 200)
//   offset     — 0-based offset (default 0)
//   search     — case-insensitive name filter (ILIKE %term%)
//   pins_first — ignored (pins are server-local; use the LAN library for pin ordering)
//
// Response: { games: GameEntry[], total: number }
//
// GameEntry: { id, name, platform, serverId, maxPlayers }

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
  const conditions = [inArray(serverGames.serverId, serverIds)];
  if (search) {
    conditions.push(ilike(serverGames.name, `%${search}%`));
  }

  // Count total
  const [{ count }] = await db
    .select({ count: sql<number>`count(*)` })
    .from(serverGames)
    .where(and(...conditions));

  // Fetch page
  const rows = await db
    .select({
      id: serverGames.gameId,
      name: serverGames.name,
      platform: serverGames.platform,
      serverId: serverGames.serverId,
      maxPlayers: serverGames.maxPlayers,
    })
    .from(serverGames)
    .where(and(...conditions))
    .orderBy(serverGames.name)
    .limit(limit)
    .offset(offset);

  const games = rows.map((r) => ({
    id: r.id,
    name: r.name,
    platform: r.platform,
    serverId: r.serverId,
    maxPlayers: r.maxPlayers,
  }));

  return NextResponse.json({ games, total: Number(count) });
}
