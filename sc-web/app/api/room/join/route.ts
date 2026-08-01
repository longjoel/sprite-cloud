import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { commands, sessions } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { logSignalingStage } from "@/lib/signaling";
import { playerCapabilities, spectatorCapabilities } from "@/lib/capabilities";
import { issueRoomPeer } from "@/lib/peer-tokens";

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

  logSignalingStage("guest_join", "request_received", {
    client_id: clientId,
    has_client_id: !!clientId,
    has_room_token: true,
  });

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
    logSignalingStage("guest_join", "session_lookup_failed", {
      has_room_token: true,
    });
    return NextResponse.json({ error: "room not found" }, { status: 404 });
  }

  if (!["spawning", "ready", "connected", "playing"].includes(session.status)) {
    return NextResponse.json({ error: "session ended" }, { status: 410 });
  }

  if (!session.workerUrl) {
    return NextResponse.json({ error: "session not ready" }, { status: 503 });
  }

  logSignalingStage("guest_join", "session_resolved", {
    game_id: session.gameId,
    server_id: session.serverId,
    session_id: session.id,
    session_status: session.status,
    worker_url: session.workerUrl,
  });

  // Without a client_id, this is a preview call (e.g. PlayPage resolving
  // the session to show the UI). Don't create a peer_token — the actual
  // join happens via play.js which always sends a client_id.
  if (!clientId) {
    // Invariant: preview requests resolve room metadata only. They MUST NOT mint
    // a peer token because no actual signaling leg has started yet.
    logSignalingStage("guest_join", "preview_resolved", {
      game_id: session.gameId,
      session_id: session.id,
      has_worker_token: typeof session.commandWorkerToken === "string",
    });
    return NextResponse.json({
      worker_url: session.workerUrl,
      game_id: session.gameId,
      server_id: session.serverId,
      max_seats: session.maxSeats,
      worker_token: session.commandWorkerToken,
      capabilities: spectatorCapabilities(),
    });
  }

  const peer = await issueRoomPeer(db, {
    sessionId: session.id,
    clientId,
    maxSeats: session.maxSeats,
  });

  logSignalingStage("guest_join", peer.reused ? "peer_reused" : "peer_issued", {
    role: peer.role,
    seat: peer.seat,
    session_id: session.id,
    has_worker_token: typeof session.commandWorkerToken === "string",
  });

  return NextResponse.json({
    worker_url: session.workerUrl,
    game_id: session.gameId,
    server_id: session.serverId,
    max_seats: session.maxSeats,
    worker_token: session.commandWorkerToken,
    peer_token: peer.token,
    seat: peer.seat,
    role: peer.role,
    capabilities: peer.role === "player" ? playerCapabilities(peer.seat) : spectatorCapabilities(),
  });
}
