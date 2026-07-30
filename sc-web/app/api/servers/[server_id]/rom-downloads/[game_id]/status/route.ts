import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { commands, serverMembers, servers } from "@/lib/db/schema";
import { and, desc, eq } from "drizzle-orm";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ server_id: string; game_id: string }> },
) {
  const { server_id, game_id } = await params;

  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "sign in first" }, { status: 401 });
  }

  // Admin membership check
  const [membership] = await db
    .select({ role: serverMembers.role })
    .from(serverMembers)
    .innerJoin(servers, eq(servers.id, serverMembers.serverId))
    .where(
      and(
        eq(serverMembers.serverId, server_id),
        eq(serverMembers.userId, session.user.id),
      ),
    )
    .limit(1);

  if (!membership) {
    return NextResponse.json({ error: "not authorized" }, { status: 403 });
  }
  if (membership.role !== "admin") {
    return NextResponse.json({ error: "administrator role required" }, { status: 403 });
  }

  // Find the latest rom_download command for this game
  const [cmd] = await db
    .select({
      id: commands.id,
      type: commands.type,
      status: commands.status,
      result: commands.result,
      createdAt: commands.createdAt,
    })
    .from(commands)
    .where(
      and(
        eq(commands.serverId, server_id),
        eq(commands.type, "rom_download"),
      ),
    )
    .orderBy(desc(commands.createdAt))
    .limit(1);

  if (!cmd) {
    return NextResponse.json({ error: "no download command found" }, { status: 404 });
  }

  // Return the result (contains SDP offer when server processes it)
  if (cmd.result && typeof cmd.result === "object") {
    return NextResponse.json(cmd.result as Record<string, unknown>);
  }

  return NextResponse.json({ status: cmd.status, command_id: cmd.id });
}
