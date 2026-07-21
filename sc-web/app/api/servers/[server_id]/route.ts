import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import {
  servers,
  serverMembers,
  serverRomRoots,
  gameFiles,
  commands,
  sessions,
} from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";

// ── PATCH /api/servers/[server_id] — rename server (admin only) ──────

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ server_id: string }> },
) {
  const { server_id } = await params;
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  // Must be admin of this server
  const [membership] = await db
    .select({ role: serverMembers.role })
    .from(serverMembers)
    .where(
      and(
        eq(serverMembers.serverId, server_id),
        eq(serverMembers.userId, session.user.id),
        eq(serverMembers.role, "admin"),
      ),
    )
    .limit(1);

  if (!membership) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  let body: { name?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  if (!body.name || typeof body.name !== "string" || body.name.trim().length === 0) {
    return NextResponse.json({ error: "name is required" }, { status: 400 });
  }

  const name = body.name.trim();
  if (name.length > 64) {
    return NextResponse.json({ error: "name too long (max 64)" }, { status: 400 });
  }

  await db
    .update(servers)
    .set({ name })
    .where(eq(servers.id, server_id));

  return NextResponse.json({ ok: true, name });
}

// ── DELETE /api/servers/[server_id] — cascade delete (admin only) ────

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ server_id: string }> },
) {
  const { server_id } = await params;
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  // Must be admin of this server
  const [membership] = await db
    .select({ role: serverMembers.role })
    .from(serverMembers)
    .where(
      and(
        eq(serverMembers.serverId, server_id),
        eq(serverMembers.userId, session.user.id),
        eq(serverMembers.role, "admin"),
      ),
    )
    .limit(1);

  if (!membership) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  // Cascade delete: children first, then the server itself
  // Order matters — FK constraints would block out-of-order deletes
  await db.delete(sessions).where(eq(sessions.serverId, server_id));
  await db.delete(commands).where(eq(commands.serverId, server_id));
  await db.delete(gameFiles).where(eq(gameFiles.serverId, server_id));
  await db.delete(serverRomRoots).where(eq(serverRomRoots.serverId, server_id));
  await db.delete(serverMembers).where(eq(serverMembers.serverId, server_id));
  await db.delete(servers).where(eq(servers.id, server_id));

  return NextResponse.json({ ok: true });
}
