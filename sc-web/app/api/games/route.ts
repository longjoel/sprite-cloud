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
//   limit    — rows per page (default 100, max 200)
//   offset   — 0-based offset (default 0)
//   search   — case-insensitive name filter (ILIKE %term%)
//   platform — optional platform filter (exact match)
//
// Response:
// {
//   games:      GameEntry[],
//   total:      number,       // total matching games for pagination
//   platforms:  { name: string, count: number }[],  // full catalog facets
// }

interface GameEntry {
  id: string;
  name: string;
  platform: string;
  serverId: string;
  maxPlayers: number;
  coverUrl?: string | null;
}

export async function GET(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "sign in first" }, { status: 401 });
  }

  const url = new URL(request.url);
  const limit = Math.min(Math.max(parseInt(url.searchParams.get("limit") || "100"), 1), 200);
  const offset = Math.max(parseInt(url.searchParams.get("offset") || "0"), 0);
  const search = (url.searchParams.get("search") || "").trim();
  const platform = (url.searchParams.get("platform") || "").trim();

  const memberships = await db
    .select({ serverId: serverMembers.serverId })
    .from(serverMembers)
    .where(eq(serverMembers.userId, session.user.id));

  const serverIds = memberships.map((m) => m.serverId);
  if (serverIds.length === 0) {
    return NextResponse.json({ games: [], total: 0, platforms: [] });
  }

  const baseWhere = and(inArray(serverGames.serverId, serverIds));

  // Platform facets: count across all unfiltered games (obeys search only)
  const facetWhere = and(
    baseWhere,
    ...(search ? [ilike(serverGames.name, `%${search}%`)] : []),
  );
  const platformRows = await db
    .select({
      name: serverGames.platform,
      count: sql<number>`count(*)`,
    })
    .from(serverGames)
    .where(facetWhere)
    .groupBy(serverGames.platform)
    .orderBy(serverGames.platform);

  // Build page filter (search + platform)
  const pageConditions = [baseWhere];
  if (search) pageConditions.push(ilike(serverGames.name, `%${search}%`));
  if (platform) pageConditions.push(eq(serverGames.platform, platform));
  const pageWhere = and(...pageConditions);

  const [{ count: total }] = await db
    .select({ count: sql<number>`count(*)` })
    .from(serverGames)
    .where(pageWhere);

  const rows = await db
    .select({
      id: serverGames.gameId,
      name: serverGames.name,
      platform: serverGames.platform,
      serverId: serverGames.serverId,
      maxPlayers: serverGames.maxPlayers,
    })
    .from(serverGames)
    .where(pageWhere)
    .orderBy(serverGames.name)
    .limit(limit)
    .offset(offset);

  return NextResponse.json({
    games: rows.map((r) => ({ id: r.id, name: r.name, platform: r.platform, serverId: r.serverId, maxPlayers: r.maxPlayers, coverUrl: `/api/covers/${r.id}?name=${encodeURIComponent(r.name)}&platform=${encodeURIComponent(r.platform)}` })),
    total: Number(total),
    platforms: platformRows.map((r) => ({ name: r.name, count: Number(r.count) })),
  });
}
