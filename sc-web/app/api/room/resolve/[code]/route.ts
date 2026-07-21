import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { games, sessions, shortCodes, serverMembers, servers } from "@/lib/db/schema";
import { and, eq, inArray, isNotNull } from "drizzle-orm";

// ── GET /api/room/resolve/:code — resolve a short code to game params
//
// Auth-aware:
//   Host (authenticated server member) → host_token for reconnection or restart
//   Guest (unauthenticated)            → room_token for guest join (no auth needed)

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ code: string }> },
) {
  const { code } = await params;

  if (!code || code.length > 16) {
    return NextResponse.json({ error: "invalid code" }, { status: 400 });
  }

  // Force guest mode when ?join is present — even server members join as guests
  const url = new URL(request.url);
  const forceGuest = url.searchParams.has("join");

  const [entry] = await db
    .select({
      gameId: shortCodes.gameId,
      hostToken: shortCodes.hostToken,
      serverId: shortCodes.serverId,
    })
    .from(shortCodes)
    .where(eq(shortCodes.code, code.toUpperCase()))
    .limit(1);

  if (!entry) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  // Public-safe metadata selects the correct virtual controller on LAN proxy
  // pages, where sc-web authentication cookies are unavailable.
  const [game] = await db
    .select({ name: games.name, platform: games.platform })
    .from(games)
    .where(eq(games.id, entry.gameId))
    .limit(1);
  const gameMetadata = { game_name: game?.name, platform: game?.platform };

  // LAN proxy pass-through: if the caller provides the correct host_token
  // in the query string, treat them as the host (no auth session needed).
  // This lets sc-server's player proxy negotiate host reconnection without
  // browser auth cookies from the sc-web origin.
  const tokenHint = url.searchParams.get("host_token") || undefined;
  let isHost = false;
  if (tokenHint && tokenHint === entry.hostToken) {
    isHost = true;
  }

  // Fall back to auth session check if token hint didn't match
  if (!isHost && !forceGuest) {
    const session = await auth();
    if (session?.user?.id) {
      const [membership] = await db
        .select({ role: serverMembers.role })
        .from(serverMembers)
        .innerJoin(servers, eq(servers.id, serverMembers.serverId))
        .where(
          and(
            eq(serverMembers.serverId, entry.serverId),
            eq(serverMembers.userId, session.user.id),
          ),
        )
        .limit(1);
      isHost = !!membership;
    }
  }

  if (isHost) {
    // Authenticated server member → host_token for reconnection or fresh start
    return NextResponse.json({
      game_id: entry.gameId,
      host_token: entry.hostToken,
      server_id: entry.serverId,
      ...gameMetadata,
    });
  }

  // Guest: look up the active session's room_token
  const [activeSession] = await db
    .select({ roomToken: sessions.roomToken, status: sessions.status })
    .from(sessions)
    .where(
      and(
        eq(sessions.serverId, entry.serverId),
        eq(sessions.gameId, entry.gameId),
        eq(sessions.hostToken, entry.hostToken),
        isNotNull(sessions.roomToken),
        inArray(sessions.status, ["spawning", "ready", "connected", "playing"]),
      ),
    )
    .orderBy(sessions.createdAt)
    .limit(1);

  if (activeSession?.roomToken) {
    return NextResponse.json({
      game_id: entry.gameId,
      server_id: entry.serverId,
      room_token: activeSession.roomToken,
      ...gameMetadata,
    });
  }

  // No active session — check if any session existed (ended/crashed)
  const [anySession] = await db
    .select({ status: sessions.status })
    .from(sessions)
    .where(
      and(
        eq(sessions.serverId, entry.serverId),
        eq(sessions.gameId, entry.gameId),
        eq(sessions.hostToken, entry.hostToken),
        isNotNull(sessions.roomToken),
      ),
    )
    .orderBy(sessions.createdAt)
    .limit(1);

  if (anySession) {
    return NextResponse.json(
      { error: "session ended — ask the host to restart" },
      { status: 410 },
    );
  }

  return NextResponse.json(
    { error: "no active session — waiting for host" },
    { status: 404 },
  );
}
