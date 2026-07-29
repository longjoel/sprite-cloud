import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { serverMembers, sessions } from "@/lib/db/schema";
import { verifyBearerToken } from "@/lib/server-auth";
import { and, eq, desc } from "drizzle-orm";
import { randomBytes } from "crypto";

// ── POST /api/room/share — share or rotate a room_token
//
// Authenticated. A session owner, server admin, or owning sc-server bearer
// may share an active session.
// Body: { session_id?: string, game_id?: string, server_id?: string, max_seats?: number }
// Returns: { room_token: string, max_seats: number }

export async function POST(request: NextRequest) {
  const userSession = await auth();
  const userId = userSession?.user?.id;
  const bearerServer = userId
    ? null
    : await verifyBearerToken(request.headers.get("authorization"));
  if (!userId && !bearerServer) {
    return NextResponse.json({ error: "sign in or server bearer required" }, { status: 401 });
  }

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

  if (!["spawning", "ready", "connected", "playing"].includes(existing.status)) {
    return NextResponse.json({ error: "session ended" }, { status: 410 });
  }

  // LAN proxy: only the exact owning sc-server may rotate this session's
  // invitation capability. Browser users retain owner/admin authorization.
  if (bearerServer) {
    if (!existing.serverId || bearerServer.id !== existing.serverId) {
      return NextResponse.json({ error: "server does not own session" }, { status: 403 });
    }
  } else {
    // The initial authorization gate guarantees this branch has a browser user,
    // but keep the narrowing explicit for both TypeScript and future edits.
    if (!userId) {
      return NextResponse.json({ error: "sign in required" }, { status: 401 });
    }
    if (existing.userId !== userId) {
      const serverId = existing.serverId;
      if (!serverId) {
        return NextResponse.json({ error: "session has no server" }, { status: 500 });
      }
      // Administrators retain recovery/control authority over every session;
      // ordinary members may rotate only their own session capability.
      const [member] = await db
        .select({ id: serverMembers.id, role: serverMembers.role })
        .from(serverMembers)
        .where(
          and(
            eq(serverMembers.serverId, serverId),
            eq(serverMembers.userId, userId),
          ),
        )
        .limit(1);

      if (member?.role !== "admin") {
        return NextResponse.json({ error: "not your session" }, { status: 403 });
      }
    }
  }

  // Generate a private capability for this active session. Room tokens are
  // intentionally opaque: sharing a room must never imply site-wide publication.
  const roomToken = randomBytes(16).toString("hex");
  const maxSeats = body.max_seats ?? 4;

  await db
    .update(sessions)
    .set({ roomToken, maxSeats })
    .where(eq(sessions.id, existing.id));

  return NextResponse.json({ room_token: roomToken, max_seats: maxSeats });
}
