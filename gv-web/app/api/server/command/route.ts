import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { commands, serverMembers, servers } from "@/lib/db/schema";
import { CMD_SDP_OFFER, CMD_START_GAME, CMD_STOP_GAME } from "@/lib/constants";
import { and, eq } from "drizzle-orm";

// ── Validation ─────────────────────────────────────────────────────────

const VALID_TYPES = new Set<string>([CMD_START_GAME, CMD_STOP_GAME, CMD_SDP_OFFER]);

interface CommandBody {
  server_id: string;
  type: string;
  payload?: unknown;
}

// ── Handler ────────────────────────────────────────────────────────────

/**
 * POST /api/server/command
 *
 * Authenticated user queues a command for one of their servers.
 * Only server owners (admins in server_members) can enqueue commands.
 */
export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "sign in first" }, { status: 401 });
  }

  let body: CommandBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  // Validate type
  if (!body.type || !VALID_TYPES.has(body.type)) {
    return NextResponse.json(
      { error: `invalid type — must be one of: ${[...VALID_TYPES].join(", ")}` },
      { status: 400 },
    );
  }

  // Validate server_id
  if (!body.server_id) {
    return NextResponse.json({ error: "server_id required" }, { status: 400 });
  }

  // Verify the user owns this server (admin role)
  const [membership] = await db
    .select({ role: serverMembers.role })
    .from(serverMembers)
    .innerJoin(servers, eq(servers.id, serverMembers.serverId))
    .where(
      and(
        eq(serverMembers.serverId, body.server_id),
        eq(serverMembers.userId, session.user.id),
        eq(serverMembers.role, "admin"),
      ),
    )
    .limit(1);

  if (!membership) {
    return NextResponse.json(
      { error: "server not found or not authorized" },
      { status: 403 },
    );
  }

  // Insert command
  const [cmd] = await db
    .insert(commands)
    .values({
      serverId: body.server_id,
      type: body.type,
      payload: body.payload ?? {},
    })
    .returning({ id: commands.id });

  return NextResponse.json({ id: cmd.id }, { status: 201 });
}
