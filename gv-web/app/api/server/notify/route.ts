import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { commands, sessions, servers } from "@/lib/db/schema";
import { verifyBearerToken, unauthorizedResponse } from "@/lib/server-auth";
import { and, eq, ne, desc } from "drizzle-orm";
import { STATUS_COMPLETED, STATUS_LEASED, SESSION_READY, SESSION_CONNECTED, SESSION_ENDED } from "@/lib/constants";
import { applyRateLimit } from "@/lib/rate-limit";
import { randomBytes } from "crypto";
import { recordLaunchEvent } from "@/lib/launch-events";
import { resolveSdpAnswer } from "@/lib/pending-sdp";

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

  // Guard: __worker_dead__ is a sentinel — MUST be handled before any DB
  // query that uses command_id as a UUID. Treat it as a stop action even
  // if the caller didn't explicitly set action="stop".
  const isWorkerDead = body.command_id === "__worker_dead__";
  const effectiveAction = isWorkerDead ? "stop" : body.action;

  const missing = effectiveAction === "stop"
    ? !body.command_id || !body.game_id
    : !body.command_id || !body.worker_url || !body.game_id;
  if (missing) {
    return NextResponse.json(
      { error: "command_id, worker_url, and game_id required" },
      { status: 400 },
    );
  }

  // ── Stop action: transition session to ended ──────────────────────────
  if (effectiveAction === "stop") {

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

  // ── Record launch timeline event ────────────────────────────────────
  if (body.sdp_answer) {
    await recordLaunchEvent({
      commandId: body.command_id,
      serverId: server.id,
      gameId: body.game_id,
      sessionId: body.session_id ?? null,
      source: "gv-web",
      event: "sdp_answer_returned",
      detail: {},
    });

    // Wake any long-polling start_game request waiting on this answer
    resolveSdpAnswer(body.command_id, body.sdp_answer);
  } else {
    await recordLaunchEvent({
      commandId: body.command_id,
      serverId: server.id,
      gameId: body.game_id,
      sessionId: body.session_id ?? null,
      source: "gv-web",
      event: "worker_http_ready",
      detail: { worker_url: body.worker_url },
    });
  }

  return NextResponse.json({ ok: true, room_token: roomToken });
}

// ── GET — browser polls for worker URL / SDP answer ─────────────────────

interface NotifyRow {
  sessionId: string;
  workerUrl: string | null;
  gameId: string | null;
  status: string | null;
  sdpAnswer: string | null;
  roomToken: string | null;
  cmdResult: unknown;
}

function processRow(row: NotifyRow | undefined): NextResponse {
  // Fail fast: if the command has a terminal error, surface it.
  if (row?.cmdResult && typeof row.cmdResult === "object" && (row.cmdResult as any).error) {
    const err = (row.cmdResult as any).error;
    const msg = (row.cmdResult as any).message;
    return NextResponse.json({ error: err, message: msg || undefined });
  }

  if (!row || !row.workerUrl) {
    return NextResponse.json({ worker_url: null });
  }

  return NextResponse.json({
    session_id: row.sessionId,
    worker_url: row.workerUrl,
    game_id: row.gameId,
    status: row.status,
    sdp_answer: row.sdpAnswer ?? null,
    room_token: row.roomToken ?? null,
  });
}

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
  // Also check the command's result for terminal errors (session gone, etc.)
  //
  // Two-phase lookup because sdp_offer commands have different workerTokens
  // than the start_game command the session is tied to.
  const [row] = await db
    .select({
      sessionId: sessions.id,
      workerUrl: sessions.workerUrl,
      gameId: sessions.gameId,
      status: sessions.status,
      sdpAnswer: sessions.sdpAnswer,
      roomToken: sessions.roomToken,
      cmdResult: commands.result,
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

  // If the workerToken didn't match via start_game's commandId, try
  // finding the session by server + game (sdp_offer workerToken path).
  if (!row) {
    // Look up the command's game_id from the sdp_offer workerToken
    const [cmd] = await db
      .select({ gameId: commands.payload })
      .from(commands)
      .where(eq(commands.workerToken, workerToken))
      .limit(1);
    if (cmd) {
      const payload = cmd.gameId as Record<string, unknown> | null;
      const gameId = payload?.game_id as string | undefined;
      if (gameId) {
        const [fallback] = await db
          .select({
            sessionId: sessions.id,
            workerUrl: sessions.workerUrl,
            gameId: sessions.gameId,
            status: sessions.status,
            sdpAnswer: sessions.sdpAnswer,
            roomToken: sessions.roomToken,
            cmdResult: commands.result,
          })
          .from(sessions)
          .innerJoin(commands, eq(commands.id, sessions.commandId))
          .where(
            and(
              eq(sessions.serverId, serverId),
              eq(sessions.gameId, gameId),
            ),
          )
          .orderBy(sessions.createdAt)
          .limit(1);
        if (fallback) {
          return processRow(fallback);
        }
      }
    }
  }

  return processRow(row);
}
