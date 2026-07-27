import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { serverMembers, sessions, shortCodes } from "@/lib/db/schema";
import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { verifyBearerToken } from "@/lib/server-auth";

// ── GET /api/room/resolve/:code — resolve a short code to game params
//
// Capability-aware:
//   Owning sc-server bearer → host_token for LAN reconnection or restart
//   Every browser visitor   → room_token for guest join (no auth needed)

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

  // Private invitation entries carry the rotating 128-bit room capability,
  // never the reusable host capability. Resolve this exact session as a guest
  // before considering either browser or sc-server host authority.
  if (/^[a-f0-9]{32}$/.test(entry.hostToken)) {
    const [inviteSession] = await db
      .select({ roomToken: sessions.roomToken, status: sessions.status })
      .from(sessions)
      .where(and(
        eq(sessions.serverId, entry.serverId),
        eq(sessions.gameId, entry.gameId),
        eq(sessions.roomToken, entry.hostToken),
      ))
      .limit(1);

    if (!inviteSession || !["spawning", "ready", "connected", "playing"].includes(inviteSession.status)) {
      return NextResponse.json(
        { error: "session ended — ask the host to share again" },
        { status: 410 },
      );
    }
    return NextResponse.json({
      game_id: entry.gameId,
      server_id: entry.serverId,
      room_token: inviteSession.roomToken,
    });
  }

  // Paired sc-server proxies this exact route with its server bearer. The
  // browser never carries the host capability in its launch URL.
  const bearerServer = forceGuest
    ? null
    : await verifyBearerToken(request.headers.get("authorization"));
  let isHost = bearerServer?.id === entry.serverId;

  if (!isHost && !forceGuest) {
    const browserSession = await auth();
    if (browserSession?.user?.id) {
      const [membership] = await db
        .select({ role: serverMembers.role })
        .from(serverMembers)
        .where(and(
          eq(serverMembers.serverId, entry.serverId),
          eq(serverMembers.userId, browserSession.user.id),
          eq(serverMembers.role, "admin"),
        ))
        .limit(1);
      isHost = membership?.role === "admin";
    }
  }

  if (isHost) {
    // Host authority belongs only to the paired server bearer or an explicit
    // server admin. Ordinary members never upgrade into host access.
    return NextResponse.json({
      game_id: entry.gameId,
      host_token: entry.hostToken,
      server_id: entry.serverId,
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
