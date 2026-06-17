import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { servers, serverMembers } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";

// GET /api/servers/[server_id]/metadata
// Returns non-secret connectivity/capability metadata for the server.
// Authorization: must be a member of the server (admin or member).
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ server_id: string }> },
) {
  const { server_id } = await params;

  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  // Verify the caller is a member of this server
  const membership = await db
    .select()
    .from(serverMembers)
    .where(
      and(
        eq(serverMembers.serverId, server_id),
        eq(serverMembers.userId, session.user.id),
      ),
    )
    .limit(1);

  if (membership.length === 0) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  // Fetch server metadata
  const server = await db
    .select({ metadata: servers.metadata, lastSeenAt: servers.lastSeenAt, name: servers.name })
    .from(servers)
    .where(eq(servers.id, server_id))
    .limit(1);

  if (server.length === 0) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  return NextResponse.json({
    name: server[0].name,
    last_seen_at: server[0].lastSeenAt,
    metadata: server[0].metadata ?? {},
  });
}
