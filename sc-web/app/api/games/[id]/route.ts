import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { serverGames, serverMembers } from "@/lib/db/schema";
import { eq, and, inArray } from "drizzle-orm";

// ── GET /api/games/:id ─────────────────────────────────────────────────
//
// Returns cached game metadata from the server-pushed catalog.
// Scoped to servers the authenticated user is a member of.

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "sign in first" }, { status: 401 });
  }

  const { id: gameId } = await params;

  // Resolve user's server memberships
  const memberships = await db
    .select({ serverId: serverMembers.serverId })
    .from(serverMembers)
    .where(eq(serverMembers.userId, session.user.id));

  const serverIds = memberships.map((m) => m.serverId);
  if (serverIds.length === 0) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const [game] = await db
    .select({
      id: serverGames.gameId,
      name: serverGames.name,
      platform: serverGames.platform,
      maxPlayers: serverGames.maxPlayers,
      serverId: serverGames.serverId,
    })
    .from(serverGames)
    .where(
      and(
        eq(serverGames.gameId, gameId),
        inArray(serverGames.serverId, serverIds),
      ),
    )
    .limit(1);

  if (!game) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  return NextResponse.json(game);
}
