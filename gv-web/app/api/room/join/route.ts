import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { sessions } from "@/lib/db/schema";
import { eq } from "drizzle-orm";

// ── POST /api/room/join — guest resolves a room_token to session details
//
// No auth required — the room_token IS the auth.
// Returns worker_url + game info so the guest can connect.

export async function POST(request: NextRequest) {
  let body: { room_token: string };
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

  const [session] = await db
    .select({
      id: sessions.id,
      workerUrl: sessions.workerUrl,
      gameId: sessions.gameId,
      serverId: sessions.serverId,
      status: sessions.status,
      maxSeats: sessions.maxSeats,
    })
    .from(sessions)
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

  return NextResponse.json({
    worker_url: session.workerUrl,
    game_id: session.gameId,
    server_id: session.serverId,
    max_seats: session.maxSeats,
  });
}
