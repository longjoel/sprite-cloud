import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { commands, serverMembers, servers, users } from "@/lib/db/schema";
import { applyRateLimit } from "@/lib/rate-limit";
import { and, eq } from "drizzle-orm";

const DOWNLOAD_RATE_LIMIT = 5;

function cookieValue(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const [rawKey, ...rest] = part.trim().split("=");
    if (rawKey === name) return decodeURIComponent(rest.join("="));
  }
  return null;
}

function validateCsrf(request: NextRequest): boolean {
  const headerToken = request.headers.get("x-csrf-token");
  const cookieToken = cookieValue(
    request.headers.get("cookie"),
    "sc_csrf_token",
  );
  return !!headerToken && !!cookieToken && headerToken === cookieToken;
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ server_id: string }> },
) {
  const { server_id } = await params;

  const rateLimited = applyRateLimit(request, DOWNLOAD_RATE_LIMIT);
  if (rateLimited) return rateLimited;

  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "sign in first" }, { status: 401 });
  }
  if (!validateCsrf(request)) {
    return NextResponse.json({ error: "csrf token invalid" }, { status: 403 });
  }

  let body: { game_id?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  if (typeof body.game_id !== "string" || body.game_id.length === 0) {
    return NextResponse.json({ error: "game_id is required" }, { status: 400 });
  }
  const game_id = body.game_id;

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

  // Queue download command for sc-server
  const accountUserId = session.user.id;
  const [cmd] = await db.transaction(async (tx) => {
    const [account] = await tx.select({ id: users.id }).from(users).where(eq(users.id, accountUserId)).for("update");
    if (!account) throw new Error("account no longer exists");
    return tx.insert(commands).values({
      serverId: server_id,
      type: "rom_download",
      payload: { game_id, server_id, authorized_user_id: accountUserId },
      status: "pending",
    }).returning({ id: commands.id });
  });

  return NextResponse.json({ ok: true, command_id: cmd.id, game_id });
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ server_id: string }> },
) {
  const { server_id } = await params;
  const url = new URL(request.url);
  const command_id = url.searchParams.get("command_id");

  if (!command_id) {
    return NextResponse.json({ error: "missing command_id" }, { status: 400 });
  }

  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "sign in first" }, { status: 401 });
  }

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

  const [cmd] = await db
    .select({
      id: commands.id,
      status: commands.status,
      result: commands.result,
    })
    .from(commands)
    .where(
      and(
        eq(commands.id, command_id),
        eq(commands.serverId, server_id),
        eq(commands.type, "rom_download"),
      ),
    );

  if (!cmd) {
    return NextResponse.json({ error: "command not found" }, { status: 404 });
  }

  if (cmd.result && typeof cmd.result === "object") {
    return NextResponse.json(cmd.result as Record<string, unknown>);
  }

  return NextResponse.json({ status: cmd.status });
}
