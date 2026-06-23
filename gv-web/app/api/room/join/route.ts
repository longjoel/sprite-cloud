import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { commands, peerTokens, sessions } from "@/lib/db/schema";
import { and, eq, sql } from "drizzle-orm";
import crypto from "crypto";

// ── POST /api/room/join — guest resolves a room_token to session details
//
// No auth required — the room_token IS the auth.
// Returns worker_url + game info + peer_token so the guest can connect.

export async function POST(request: NextRequest) {
  let body: { room_token: string; client_id?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  if (!body.room_token || typeof body.room_token !== "string") {
    return NextResponse.json({ error: "room_token required" }, { status: 400 });
  }

  if (body.room_token.length > 64) {
    return NextResponse.json({ error: "invalid room_token" }, { status: 400 });
  }

  const clientId = typeof body.client_id === "string" && body.client_id.length <= 64
    ? body.client_id
    : undefined;

  const [session] = await db
    .select({
      id: sessions.id,
      workerUrl: sessions.workerUrl,
      gameId: sessions.gameId,
      serverId: sessions.serverId,
      status: sessions.status,
      maxSeats: sessions.maxSeats,
      commandWorkerToken: commands.workerToken,
    })
    .from(sessions)
    .leftJoin(commands, eq(commands.id, sessions.commandId))
    .where(eq(sessions.roomToken, body.room_token))
    .limit(1);

  if (!session) {
    return NextResponse.json({ error: "room not found" }, { status: 404 });
  }

  if (session.status === "stopped" || session.status === "ended") {
    return NextResponse.json({ error: "session ended" }, { status: 410 });
  }

  if (!session.workerUrl) {
    return NextResponse.json({ error: "session not ready" }, { status: 503 });
  }

  if (clientId) {
    const [existingPeer] = await db
      .select({ token: peerTokens.token, seat: peerTokens.seat, role: peerTokens.role })
      .from(peerTokens)
      .where(and(eq(peerTokens.sessionId, session.id), eq(peerTokens.clientId, clientId)))
      .limit(1);

    if (existingPeer) {
      return NextResponse.json({
        worker_url: session.workerUrl,
        game_id: session.gameId,
        server_id: session.serverId,
        max_seats: session.maxSeats,
        worker_token: session.commandWorkerToken,
        peer_token: existingPeer.token,
        seat: existingPeer.seat,
        role: existingPeer.role,
      });
    }
  }

  // Count existing peers for this session to assign the next seat.
  // Reused client_id rows are returned above and do not consume another seat.
  const [countResult] = await db
    .select({ count: sql<number>`count(*)` })
    .from(peerTokens)
    .where(eq(peerTokens.sessionId, session.id));

  const existingCount = countResult?.count ?? 0;
  const seat = existingCount; // 0=host (already exists), 1=first guest, etc.
  const role = seat < session.maxSeats ? "player" : "viewer";

  // Issue guest peer_token
  const guestPeerToken = crypto.randomBytes(16).toString("hex");
  await db.insert(peerTokens).values({
    sessionId: session.id,
    token: guestPeerToken,
    seat,
    role,
    clientId,
  });

  return NextResponse.json({
    worker_url: session.workerUrl,
    game_id: session.gameId,
    server_id: session.serverId,
    max_seats: session.maxSeats,
    worker_token: session.commandWorkerToken,
    peer_token: guestPeerToken,
    seat,
    role,
  });
}
