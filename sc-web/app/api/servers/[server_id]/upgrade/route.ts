import { NextRequest, NextResponse } from "next/server";
import { and, eq, inArray } from "drizzle-orm";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { commands, serverMembers, servers, sessions, users } from "@/lib/db/schema";
import { ACTIVE_SESSION_STATES, STATUS_LEASED, STATUS_PENDING } from "@/lib/constants";

const CMD_UPGRADE_SERVER = "upgrade_server";

function cookieValue(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return null;
}

function validCsrf(request: NextRequest): boolean {
  const header = request.headers.get("x-csrf-token");
  const cookie = cookieValue(request.headers.get("cookie"), "sc_csrf_token");
  return !!header && !!cookie && header === cookie;
}

/** Queue a verified sc-server + sc-core update for an administrator's server. */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ server_id: string }> },
) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "sign in first" }, { status: 401 });
  if (!validCsrf(request)) return NextResponse.json({ error: "csrf token invalid" }, { status: 403 });

  const { server_id } = await params;
  const [membership] = await db
    .select({ role: serverMembers.role })
    .from(serverMembers)
    .innerJoin(servers, eq(servers.id, serverMembers.serverId))
    .where(and(eq(serverMembers.serverId, server_id), eq(serverMembers.userId, session.user.id)))
    .limit(1);
  if (!membership) return NextResponse.json({ error: "server not found" }, { status: 404 });
  if (membership.role !== "admin") return NextResponse.json({ error: "administrator access required" }, { status: 403 });

  const [activeSession] = await db
    .select({ id: sessions.id })
    .from(sessions)
    .where(and(
      eq(sessions.serverId, server_id),
      inArray(sessions.status, [...ACTIVE_SESSION_STATES]),
    ))
    .limit(1);
  if (activeSession) {
    return NextResponse.json({ error: "finish active games before updating" }, { status: 409 });
  }

  const [active] = await db
    .select({ id: commands.id, status: commands.status })
    .from(commands)
    .where(and(
      eq(commands.serverId, server_id),
      eq(commands.type, CMD_UPGRADE_SERVER),
      inArray(commands.status, [STATUS_PENDING, STATUS_LEASED]),
    ))
    .limit(1);
  if (active) {
    return NextResponse.json({ error: "an update is already queued", command_id: active.id, status: active.status }, { status: 409 });
  }

  let command: { id: string; status: string };
  try {
    const accountUserId = session.user.id;
    [command] = await db.transaction(async (tx) => {
      const [account] = await tx.select({ id: users.id }).from(users).where(eq(users.id, accountUserId)).for("update");
      if (!account) throw new Error("account no longer exists");
      return tx.insert(commands)
        .values({ serverId: server_id, type: CMD_UPGRADE_SERVER, payload: { authorized_user_id: accountUserId } })
        .returning({ id: commands.id, status: commands.status });
    });
  } catch (error) {
    if (typeof error !== "object" || error === null || !("code" in error) || error.code !== "23505") {
      throw error;
    }
    const [winner] = await db
      .select({ id: commands.id, status: commands.status })
      .from(commands)
      .where(and(
        eq(commands.serverId, server_id),
        eq(commands.type, CMD_UPGRADE_SERVER),
        inArray(commands.status, [STATUS_PENDING, STATUS_LEASED]),
      ))
      .limit(1);
    return NextResponse.json({
      error: "an update is already queued",
      command_id: winner?.id,
      status: winner?.status,
    }, { status: 409 });
  }

  return NextResponse.json({ command_id: command.id, status: command.status }, { status: 202 });
}
