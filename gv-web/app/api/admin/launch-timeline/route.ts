import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { launchEvents, serverMembers, servers, sessions } from "@/lib/db/schema";
import { eq, and, asc } from "drizzle-orm";

/**
 * GET /api/admin/launch-timeline?session_id=<uuid> | command_id=<uuid>
 *
 * Returns all launch timeline events for a session or command, ordered
 * by created_at ascending. Requires admin membership on the owning server.
 */
export async function GET(request: NextRequest) {
  const authSession = await auth();
  if (!authSession?.user?.id) {
    return NextResponse.json({ error: "sign in first" }, { status: 401 });
  }

  const sessionId = request.nextUrl.searchParams.get("session_id");
  const commandId = request.nextUrl.searchParams.get("command_id");

  if (!sessionId && !commandId) {
    return NextResponse.json(
      { error: "session_id or command_id required" },
      { status: 400 },
    );
  }

  // Find the owning server to verify admin access
  let serverId: string | null = null;

  if (sessionId) {
    const [session] = await db
      .select({ serverId: sessions.serverId })
      .from(sessions)
      .where(eq(sessions.id, sessionId))
      .limit(1);
    serverId = session?.serverId ?? null;
  }

  if (!serverId && commandId) {
    // Try finding session via command
    const [session] = await db
      .select({ serverId: sessions.serverId })
      .from(sessions)
      .where(eq(sessions.commandId, commandId))
      .limit(1);
    serverId = session?.serverId ?? null;
  }

  if (!serverId) {
    return NextResponse.json({ error: "session not found" }, { status: 404 });
  }

  // Verify admin membership
  const [membership] = await db
    .select({ role: serverMembers.role })
    .from(serverMembers)
    .innerJoin(servers, eq(servers.id, serverMembers.serverId))
    .where(
      and(
        eq(serverMembers.serverId, serverId),
        eq(serverMembers.userId, authSession.user.id),
        eq(serverMembers.role, "admin"),
      ),
    )
    .limit(1);

  if (!membership) {
    return NextResponse.json({ error: "not authorized" }, { status: 403 });
  }

  // Query events
  let events;
  if (sessionId) {
    events = await db
      .select()
      .from(launchEvents)
      .where(eq(launchEvents.sessionId, sessionId))
      .orderBy(asc(launchEvents.createdAt));
  } else {
    events = await db
      .select()
      .from(launchEvents)
      .where(eq(launchEvents.commandId, commandId!))
      .orderBy(asc(launchEvents.createdAt));
  }

  return NextResponse.json({ events });
}
