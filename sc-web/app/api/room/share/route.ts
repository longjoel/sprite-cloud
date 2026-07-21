import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { serverMembers, sessions } from "@/lib/db/schema";
import { and, eq, desc } from "drizzle-orm";
import { randomBytes } from "crypto";

// ── POST /api/room/share — share or rotate a room_token
//
// Authenticated. Any server member can share an active session.
// Body: { session_id?: string, game_id?: string, server_id?: string, max_seats?: number }
// Returns: { room_token: string, max_seats: number }

export async function POST(request: NextRequest) {
  const userSession = await auth();
  if (!userSession?.user?.id) {
    return NextResponse.json({ error: "sign in required" }, { status: 401 });
  }
  const userId = userSession.user.id;

  let body: {
    session_id?: string;
    game_id?: string;
    server_id?: string;
    max_seats?: number;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  let existing: { id: string; userId: string; serverId: string | null; status: string } | undefined;

  if (body.session_id) {
    [existing] = await db
      .select({ id: sessions.id, userId: sessions.userId, serverId: sessions.serverId!, status: sessions.status })
      .from(sessions)
      .where(eq(sessions.id, body.session_id))
      .limit(1);
  } else if (body.game_id && body.server_id) {
    [existing] = await db
      .select({ id: sessions.id, userId: sessions.userId, serverId: sessions.serverId!, status: sessions.status })
      .from(sessions)
      .where(
        and(
          eq(sessions.gameId, body.game_id),
          eq(sessions.serverId, body.server_id),
        ),
      )
      .orderBy(desc(sessions.createdAt))
      .limit(1);
  } else {
    return NextResponse.json(
      { error: "session_id, or game_id + server_id required" },
      { status: 400 },
    );
  }

  if (!existing) {
    return NextResponse.json({ error: "session not found" }, { status: 404 });
  }

  if (existing.status === "stopped" || existing.status === "ended") {
    return NextResponse.json({ error: "session ended" }, { status: 410 });
  }

  // Auth: the user must either own the session or be a member of the server
  if (existing.userId !== userId) {
    const serverId = existing.serverId;
    if (!serverId) {
      return NextResponse.json({ error: "session has no server" }, { status: 500 });
    }
    // Check server membership
    const [member] = await db
      .select({ id: serverMembers.id })
      .from(serverMembers)
      .where(
        and(
          eq(serverMembers.serverId, serverId),
          eq(serverMembers.userId, userId),
        ),
      )
      .limit(1);

    if (!member) {
      return NextResponse.json({ error: "not your session" }, { status: 403 });
    }
  }

  // Generate new room_token (rotate even if one exists)
  const roomToken = randomBytes(16).toString("hex");
  const maxSeats = body.max_seats ?? 4;

  await db
    .update(sessions)
    .set({ roomToken, maxSeats })
    .where(eq(sessions.id, existing.id));

  return NextResponse.json({ room_token: roomToken, max_seats: maxSeats });
}
