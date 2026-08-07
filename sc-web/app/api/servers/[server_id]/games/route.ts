import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { serverGames, serverMembers } from "@/lib/db/schema";
import { and, eq } from "drizzle-orm";

// GET /api/servers/:server_id/games — list games for a server
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ server_id: string }> },
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { server_id } = await params;

  // Must be a server member
  const [member] = await db
    .select({ role: serverMembers.role })
    .from(serverMembers)
    .where(
      and(
        eq(serverMembers.serverId, server_id),
        eq(serverMembers.userId, session.user.id),
      ),
    )
    .limit(1);

  if (!member) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const rows = await db
    .select({
      game_id: serverGames.gameId,
      name: serverGames.name,
      platform: serverGames.platform,
    })
    .from(serverGames)
    .where(eq(serverGames.serverId, server_id));

  return NextResponse.json({ games: rows });
}
