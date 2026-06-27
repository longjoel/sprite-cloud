import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { sessions, shortCodes, serverMembers, servers } from "@/lib/db/schema";
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

  // Check if viewer is an authenticated member of this server → host
  const session = await auth();
  let isHost = false;
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

  if (isHost) {
    // Authenticated server member → host_token for reconnection or fresh start
    return NextResponse.json({
      game_id: entry.gameId,
      host_token: entry.hostToken,
      server_id: entry.serverId,
    });
  }

  // Guest: look up the active session's room_token
  const [activeSession] = await db
    .select({ roomToken: sessions.roomToken })
    .from(sessions)
    .where(
      and(
        eq(sessions.serverId, entry.serverId),
        eq(sessions.gameId, entry.gameId),
        eq(sessions.hostToken, entry.hostToken),
        isNotNull(sessions.roomToken),
        inArray(sessions.status, ["ready", "connected", "playing"]),
      ),
    )
    .orderBy(sessions.createdAt)
    .limit(1);

  if (!activeSession?.roomToken) {
    return NextResponse.json(
      { error: "no active session — waiting for host" },
      { status: 404 },
    );
  }

  return NextResponse.json({
    game_id: entry.gameId,
    server_id: entry.serverId,
    room_token: activeSession.roomToken,
  });
}
