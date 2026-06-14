import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { commands, sessions, servers } from "@/lib/db/schema";
import { verifyBearerToken, unauthorizedResponse } from "@/lib/server-auth";
import { and, eq } from "drizzle-orm";

// ── Types ──────────────────────────────────────────────────────────────

interface NotifyBody {
  command_id: string;
  worker_url: string;
  game_id: string;
  /** "stop" marks the session as ended (optional). */
  action?: "stop";
}

// ── POST — gv-server reports worker URL after spawn ────────────────────

export async function POST(request: NextRequest) {
  const server = await verifyBearerToken(request.headers.get("authorization"));
  if (!server) return unauthorizedResponse();

  let body: NotifyBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  if (!body.command_id || !body.worker_url || !body.game_id) {
    return NextResponse.json(
      { error: "command_id, worker_url, and game_id required" },
      { status: 400 },
    );
  }

  // Verify this server owns the command, and read its worker_token
  const [cmd] = await db
    .select({ id: commands.id, workerToken: commands.workerToken })
    .from(commands)
    .where(eq(commands.id, body.command_id))
    .limit(1);

  if (!cmd) {
    return NextResponse.json({ error: "command not found" }, { status: 404 });
  }

  // Create a session record (or update existing one for this command).
  // Propagate the worker_token from the command to the session so the
  // browser can prove ownership when polling.
  const [existing] = await db
    .select({ id: sessions.id })
    .from(sessions)
    .where(eq(sessions.commandId, body.command_id))
    .limit(1);

  // If action is \"stop\", mark the session as ended.
  const isStop = body.action === "stop";

  if (existing) {
    const update: Record<string, unknown> = isStop
      ? { status: "stopped", endedAt: new Date() }
      : { workerUrl: body.worker_url, status: "ready" };
    await db
      .update(sessions)
      .set(update)
      .where(eq(sessions.id, existing.id));
  } else if (!isStop) {
    // Only create a session on first notify if this isn't a stop.
    await db.insert(sessions).values({
      userId: server.userId,
      serverId: server.id,
      gameId: body.game_id,
      commandId: body.command_id,
      workerUrl: body.worker_url,
      status: "ready",
    });
  }

  return NextResponse.json({ ok: true });
}

// ── GET — browser polls for worker URL ─────────────────────────────────

export async function GET(request: NextRequest) {
  const serverId = request.nextUrl.searchParams.get("server_id");
  if (!serverId) {
    return NextResponse.json({ error: "server_id required" }, { status: 400 });
  }

  const workerToken = request.nextUrl.searchParams.get("worker_token");
  if (!workerToken) {
    return NextResponse.json({ error: "worker_token required" }, { status: 400 });
  }

  // Return the session whose server_id matches AND whose command has
  // the same worker_token — this proves the caller created the command.
  const [session] = await db
    .select({
      workerUrl: sessions.workerUrl,
      gameId: sessions.gameId,
      status: sessions.status,
    })
    .from(sessions)
    .innerJoin(commands, eq(commands.id, sessions.commandId))
    .where(
      and(
        eq(sessions.serverId, serverId),
        eq(commands.workerToken, workerToken),
      ),
    )
    .orderBy(sessions.createdAt)
    .limit(1);

  if (!session || !session.workerUrl) {
    return NextResponse.json({ worker_url: null });
  }

  return NextResponse.json({
    worker_url: session.workerUrl,
    game_id: session.gameId,
    status: session.status,
  });
}
