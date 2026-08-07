import { NextResponse } from "next/server";
import { and, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { gameFlags, peerTokens, serverGames, servers, sessions } from "@/lib/db/schema";
import { ACTIVE_SESSION_STATES } from "@/lib/constants";

// ── GET /api/wall ─────────────────────────────────────────────────────
//
// Public, unauthenticated — the Living Cabinet wall (#762): every game
// flagged `public` across ALL servers connected to the gateway, with server
// liveness and live-session state. Fail-closed: only `public` games appear,
// and nothing sensitive is exposed (no host tokens, no metadata, no user
// data). A live game's room token is exposed intentionally — a public game
// is a public room; the token is the capability that lets a guest watch or
// join it.
//
// Response:
// {
//   games: [{
//     id, name, platform, maxPlayers, coverUrl,
//     serverId, serverName, serverOnline,
//     live, players, viewers, maxSeats,
//     roomUrl?           // present only when live
//   }]
// }

export async function GET() {
  const rows = await db
    .select({
      gameId: serverGames.gameId,
      name: serverGames.name,
      platform: serverGames.platform,
      maxPlayers: serverGames.maxPlayers,
      serverId: serverGames.serverId,
      serverName: servers.name,
      serverOnline: sql<boolean>`${servers.lastSeenAt} > now() - interval '5 minutes'`,
      sessionId: sessions.id,
      sessionStatus: sessions.status,
      roomToken: sessions.roomToken,
      sessionMaxSeats: sessions.maxSeats,
      stateEnteredAt: sessions.stateEnteredAt,
      freePlay: gameFlags.freePlay,
      alwaysOn: gameFlags.alwaysOn,
    })
    .from(serverGames)
    .innerJoin(
      gameFlags,
      and(
        eq(gameFlags.serverId, serverGames.serverId),
        eq(gameFlags.gameId, serverGames.gameId),
      ),
    )
    .innerJoin(servers, eq(servers.id, serverGames.serverId))
    .leftJoin(
      sessions,
      and(
        eq(sessions.serverId, serverGames.serverId),
        eq(sessions.gameId, serverGames.gameId),
        inArray(sessions.status, [...ACTIVE_SESSION_STATES]),
      ),
    )
    .where(and(
      eq(gameFlags.public, true),
      or(
        isNull(serverGames.verificationState),
        ne(serverGames.verificationState, "BiosVerified"),
      ),
    ))
    .orderBy(serverGames.name);

  // Player/viewer counts for the live sessions.
  const liveSessionIds = [
    ...new Set(rows.filter((r) => r.sessionId !== null).map((r) => r.sessionId as string)),
  ];
  const countRows = liveSessionIds.length
    ? await db
        .select({
          sessionId: peerTokens.sessionId,
          role: peerTokens.role,
          count: sql<number>`count(*)`,
        })
        .from(peerTokens)
        .where(inArray(peerTokens.sessionId, liveSessionIds))
        .groupBy(peerTokens.sessionId, peerTokens.role)
    : [];

  const countsBySession = new Map<string, { players: number; viewers: number }>();
  for (const c of countRows) {
    const entry = countsBySession.get(c.sessionId) ?? { players: 0, viewers: 0 };
    if (c.role === "player") entry.players = Number(c.count);
    if (c.role === "viewer") entry.viewers = Number(c.count);
    countsBySession.set(c.sessionId, entry);
  }

  // One entry per (server, game); prefer the live row when duplicates exist.
  const byKey = new Map<string, (typeof rows)[number]>();
  for (const row of rows) {
    const key = `${row.serverId}:${row.gameId}`;
    const existing = byKey.get(key);
    if (!existing || (row.sessionId !== null && existing.sessionId === null)) {
      byKey.set(key, row);
    }
  }

  const games = [...byKey.values()].map((r) => {
    const live = r.sessionId !== null;
    const counts = r.sessionId ? countsBySession.get(r.sessionId) : undefined;
    return {
      id: r.gameId,
      name: r.name,
      platform: r.platform,
      maxPlayers: r.maxPlayers,
      coverUrl: `/api/covers/${r.serverId}/${encodeURIComponent(r.gameId)}`,
      serverId: r.serverId,
      serverName: r.serverName,
      serverOnline: r.serverOnline === true,
      live,
      players: counts?.players ?? 0,
      viewers: counts?.viewers ?? 0,
      maxSeats: r.sessionMaxSeats ?? r.maxPlayers,
      freePlay: r.freePlay === true,
      alwaysOn: r.alwaysOn === true,
      ...(live && r.roomToken
        ? {
            roomUrl: `/r/${encodeURIComponent(r.roomToken)}?game_id=${encodeURIComponent(r.gameId)}&server_id=${encodeURIComponent(r.serverId)}`,
          }
        : {}),
    };
  });

  return NextResponse.json({ games });
}
