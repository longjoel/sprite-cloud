import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { commands, sessions, servers } from "@/lib/db/schema";
import { verifyBearerToken, unauthorizedResponse } from "@/lib/server-auth";
import { and, eq, ne, desc } from "drizzle-orm";
import { STATUS_COMPLETED, STATUS_LEASED, SESSION_READY, SESSION_CONNECTED, SESSION_ENDED } from "@/lib/constants";
import { applyRateLimit } from "@/lib/rate-limit";
import { randomBytes } from "crypto";

const NOTIFY_RATE_LIMIT = 60; // requests per minute per IP (server-to-server)

// ── Types ──────────────────────────────────────────────────────────────

interface NotifyBody {
  command_id: string;
  worker_url: string;
  game_id: string;
  /** WebRTC SDP answer from worker relay (for sdp_offer commands). */
  sdp_answer?: string;
  /** "stop" marks the session as ended (optional). */
  action?: "stop";
  /** Active command lease from /api/server/poll. */
  lease_token?: string;
  /** Session ID from the start_game command payload — used to prevent
   *  stale generations from racing with newer sessions. */
  session_id?: string;
}

// ── Helpers ────────────────────────────────────────────────────────────

/** Valid state transitions for the session state machine. */
const VALID_TRANSITIONS: Record<string, string[]> = {
  spawning: [SESSION_READY, SESSION_ENDED, "timed_out"],
  ready: [SESSION_CONNECTED, SESSION_ENDED, "timed_out"],
  connected: ["playing", SESSION_ENDED, "timed_out"],
  playing: [SESSION_ENDED, "timed_out"],
};

function isValidTransition(from: string, to: string): boolean {
  return VALID_TRANSITIONS[from]?.includes(to) ?? false;
}

// ── POST — gv-server reports worker URL / SDP answer ────────────────────

export async function POST(request: NextRequest) {
  const rateLimited = applyRateLimit(request, NOTIFY_RATE_LIMIT);
  if (rateLimited) return rateLimited;

  const server = await verifyBearerToken(request.headers.get("authorization"));
  if (!server) return unauthorizedResponse();

  let body: NotifyBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const missing = body.action === "stop"
    ? !body.command_id || !body.game_id
    : !body.command_id || !body.worker_url || !body.game_id;
  if (missing) {
    return NextResponse.json(
      { error: "command_id, worker_url, and game_id required" },
      { status: 400 },
    );
  }

  // ── Stop action: transition session to ended ──────────────────────────
  if (body.action === "stop") {
    // Find the most recent active session for this game+server.
    // __worker_dead__ is a sentinel for unexpected worker exits (OOM, crash)
    // — there's no real command_id to match, so use game+server.
    const isWorkerDead = body.command_id === "__worker_dead__";

    let session: { id: string; status: string } | undefined;

    // Prefer session_id when available (most precise)
    if (body.session_id) {
      [session] = await db
        .select({ id: sessions.id, status: sessions.status })
        .from(sessions)
        .where(eq(sessions.id, body.session_id))
        .limit(1);
    }

    if (!isWorkerDead && !session) {
      // Try command_id (for explicit stop_game commands)
      [session] = await db
        .select({ id: sessions.id, status: sessions.status })
        .from(sessions)
        .where(eq(sessions.commandId, body.command_id))
        .limit(1);
    }

    // Fallback: find by game_id + server_id (for worker_dead or missing cmd match)
    if (!session) {
      [session] = await db
        .select({ id: sessions.id, status: sessions.status })
        .from(sessions)
        .where(
          and(
            eq(sessions.gameId, body.game_id),
            eq(sessions.serverId, server.id),
          ),
        )
        .orderBy(desc(sessions.createdAt))
        .limit(1);
    }

    if (session) {
      await db
        .update(sessions)
        .set({
          status: SESSION_ENDED,
          endedAt: new Date(),
          roomToken: null,
          stateEnteredAt: new Date(),
        })
        .where(eq(sessions.id, session.id));
    }

    return NextResponse.json({ ok: true });
  }

  // Verify this server owns the command
  const [cmd] = await db
    .select({ id: commands.id, serverId: commands.serverId, workerToken: commands.workerToken })
    .from(commands)
    .where(and(eq(commands.id, body.command_id), eq(commands.serverId, server.id)))
    .limit(1);

  if (!cmd || cmd.serverId !== server.id) {
    return NextResponse.json({ error: "command not found" }, { status: 404 });
  }

  // ── Complete the command lease ────────────────────────────────────────
  if (body.lease_token) {
    const [lease] = await db
      .update(commands)
      .set({ status: STATUS_COMPLETED, completedAt: new Date(), lastError: null })
      .where(
        and(
          eq(commands.id, body.command_id),
          eq(commands.serverId, server.id),
          eq(commands.status, STATUS_LEASED),
          eq(commands.leaseToken, body.lease_token),
        ),
      )
      .returning({ id: commands.id });

    if (!lease) {
      return NextResponse.json({ error: "command lease not found" }, { status: 409 });
    }
  }

  // ── Find or update session ────────────────────────────────────────────
  //
  //  Lookup order: session_id (most precise) → command_id → game_id+server_id.
  //  When updating by game_id fallback, reject if a newer generation exists
  //  (prevents stale worker_dead / SDP answers from updating newer sessions).

  let bySession: { id: string; status: string; roomToken: string | null; generation: number } | undefined;

  if (body.session_id) {
    [bySession] = await db
      .select({
        id: sessions.id,
        status: sessions.status,
        roomToken: sessions.roomToken,
        generation: sessions.generation,
      })
      .from(sessions)
      .where(eq(sessions.id, body.session_id))
      .limit(1);
  }

  if (!bySession) {
    const [byCmd] = await db
      .select({
        id: sessions.id,
        status: sessions.status,
        roomToken: sessions.roomToken,
        generation: sessions.generation,
      })
      .from(sessions)
      .where(and(eq(sessions.commandId, body.command_id)))
      .limit(1);
    bySession = byCmd;
  }

  // Determine target state
  const targetStatus = body.sdp_answer ? SESSION_CONNECTED : SESSION_READY;

  let roomToken = bySession?.roomToken || randomBytes(16).toString("hex");

  if (bySession) {
    // Found by session_id or command_id — update in place.
    // Keep the existing room_token stable across SDP renegotiations.
    await db
      .update(sessions)
      .set({
        workerUrl: body.worker_url,
        status: targetStatus,
        roomToken,
        sdpAnswer: body.sdp_answer ?? null,
        stateEnteredAt: new Date(),
      })
      .where(eq(sessions.id, bySession.id));
  } else {
    // Not found by session_id or command_id (e.g. sdp_offer after start_game).
    // Find the most recent session for this game_id+server_id, but reject
    // updates from stale generations.
    const [byGame] = await db
      .select({
        id: sessions.id,
        hostToken: sessions.hostToken,
        roomToken: sessions.roomToken,
        generation: sessions.generation,
        status: sessions.status,
      })
      .from(sessions)
      .where(
        and(
          eq(sessions.gameId, body.game_id),
          eq(sessions.serverId, server.id),
        ),
      )
      .orderBy(desc(sessions.createdAt))
      .limit(1);

    if (byGame) {
      // Reject stale updates: if a newer generation exists and this notify
      // doesn't explicitly target the current generation, skip the update.
      // This prevents an old worker's SDP answer from overwriting a new session.
      if (byGame.status === "ended" || byGame.status === "timed_out") {
        return NextResponse.json(
          { ok: false, error: "session already ended" },
          { status: 409 },
        );
      }

      roomToken = byGame.roomToken || roomToken;
      await db
        .update(sessions)
        .set({
          workerUrl: body.worker_url,
          status: targetStatus,
          roomToken,
          sdpAnswer: body.sdp_answer ?? null,
          stateEnteredAt: new Date(),
        })
        .where(eq(sessions.id, byGame.id));
    } else {
      // No session at all — create one (legacy / edge case)
      await db.insert(sessions).values({
        userId: server.userId,
        serverId: server.id,
        gameId: body.game_id,
        commandId: body.command_id,
        workerUrl: body.worker_url,
        status: targetStatus,
        roomToken,
        sdpAnswer: body.sdp_answer ?? null,
        stateEnteredAt: new Date(),
      });
    }
  }

  return NextResponse.json({ ok: true, room_token: roomToken });
}

// ── GET — browser polls for worker URL / SDP answer ─────────────────────

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
      sessionId: sessions.id,
      workerUrl: sessions.workerUrl,
      gameId: sessions.gameId,
      status: sessions.status,
      sdpAnswer: sessions.sdpAnswer,
      roomToken: sessions.roomToken,
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
    session_id: session.sessionId,
    worker_url: session.workerUrl,
    game_id: session.gameId,
    status: session.status,
    sdp_answer: session.sdpAnswer ?? null,
    room_token: session.roomToken ?? null,
  });
}
