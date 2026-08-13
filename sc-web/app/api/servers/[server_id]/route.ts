import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import {
  servers,
  serverMembers,
  launchEvents,
  peerTokens,
  commands,
  sessions,
  shortCodes,
  serverGameCoverOverrides,
} from "@/lib/db/schema";
import { eq, and, inArray } from "drizzle-orm";
import { removeCoverAssets } from "@/lib/cover-storage";

function validCsrf(request: Request): boolean {
  const header = request.headers.get("x-csrf-token");
  const cookieHeader = request.headers.get("cookie");
  const cookie = cookieHeader?.split(";").map((part) => part.trim().split("=")).find(([key]) => key === "sc_csrf_token")?.slice(1).join("=");
  return !!header && !!cookie && header === decodeURIComponent(cookie);
}

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
  request: Request,
  { params }: { params: Promise<{ server_id: string }> },
) {
  const { server_id } = await params;
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!validCsrf(request)) {
    return NextResponse.json({ error: "csrf token invalid" }, { status: 403 });
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

  // Capture private cover assets before the DB cascade removes their rows.
  // Files are garbage-collected only after the server deletion commits.
  const coverAssets = await db
    .select({
      assetId: serverGameCoverOverrides.assetId,
      posterAssetId: serverGameCoverOverrides.posterAssetId,
    })
    .from(serverGameCoverOverrides)
    .where(eq(serverGameCoverOverrides.serverId, server_id));

  // Cascade delete: children first, then the server itself
  // Order matters — FK constraints would block out-of-order deletes

  // peerTokens ──► sessions, so find session IDs for this server first
  const serverSessionRows = await db
    .select({ id: sessions.id })
    .from(sessions)
    .where(eq(sessions.serverId, server_id));

  const sessionIds = serverSessionRows.map((r) => r.id);
  if (sessionIds.length > 0) {
    await db.delete(peerTokens).where(inArray(peerTokens.sessionId, sessionIds));
  }

  // launchEvents ──► sessions, commands, servers
  await db.delete(launchEvents).where(eq(launchEvents.serverId, server_id));

  await db.delete(sessions).where(eq(sessions.serverId, server_id));
  await db.delete(commands).where(eq(commands.serverId, server_id));
  // shortCodes has no FK because legacy rows predate server ownership. Remove
  // them explicitly so room/host capabilities cannot outlive the server.
  await db.delete(shortCodes).where(eq(shortCodes.serverId, server_id));

  await db.delete(serverMembers).where(eq(serverMembers.serverId, server_id));
  await db.delete(servers).where(eq(servers.id, server_id));

  await removeCoverAssets(coverAssets.flatMap((cover) => [cover.assetId, cover.posterAssetId])).catch(() => undefined);

  return NextResponse.json({ ok: true });
}
