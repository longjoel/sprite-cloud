import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { commands, sessions, servers } from "@/lib/db/schema";
import { verifyBearerToken, unauthorizedResponse } from "@/lib/server-auth";
import { and, eq, desc } from "drizzle-orm";
import { STATUS_COMPLETED, STATUS_LEASED, SESSION_READY, SESSION_CONNECTED, SESSION_ENDED } from "@/lib/constants";
import { applyRateLimit } from "@/lib/rate-limit";
import { randomBytes } from "crypto";
import { recordLaunchEvent } from "@/lib/launch-events";
import { resolveSdpAnswer } from "@/lib/pending-sdp";
import { logSignalingStage, type SignalingFlow } from "@/lib/signaling";

const NOTIFY_RATE_LIMIT = 300; // requests per minute per IP (server-to-server, burst-tolerant)

// ── Types ──────────────────────────────────────────────────────────────

interface NotifyBody {
  command_id: string;
  // ROM-transfer signaling carries neither a worker URL nor a game ID.
  worker_url?: string;
  game_id?: string;
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

class NotifyConflict extends Error {
  constructor(readonly kind: "lease" | "session") {
    super(kind);
  }
}

function notifyTargetStatus(current: string, hasSdpAnswer: boolean): string | null {
  if (current === "playing" && hasSdpAnswer) return "playing";
  if (hasSdpAnswer && ["spawning", SESSION_READY, SESSION_CONNECTED].includes(current)) {
    return SESSION_CONNECTED;
  }
  if (!hasSdpAnswer && ["spawning", SESSION_READY].includes(current)) {
    return SESSION_READY;
  }
  return null;
}

// ── POST — sc-server reports worker URL / SDP answer ────────────────────

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
  let notifyFlow: SignalingFlow = effectiveAction === "stop" ? "stop" : "notify";
  logSignalingStage("notify", "notify_received", {
    action: effectiveAction,
    command_id: body.command_id,
    game_id: body.game_id,
    has_lease_token: !!body.lease_token,
    has_sdp_answer: typeof body.sdp_answer === "string",
    has_session_id: typeof body.session_id === "string",
    server_id: server.id,
    worker_url: body.worker_url,
  });

  if (!body.command_id) {
    return NextResponse.json({ error: "command_id required" }, { status: 400 });
  }
  if (effectiveAction !== "stop" && !body.worker_url && !body.game_id && !body.sdp_answer) {
    return NextResponse.json({ error: "notification payload required" }, { status: 400 });
  }

  // ── Stop action: transition one authorized active session to ended ──────
  if (effectiveAction === "stop") {
    if (!body.game_id) {
      return NextResponse.json({ error: "stop notification requires game_id" }, { status: 400 });
    }
    if (!body.session_id) {
      return NextResponse.json({ error: "stop notification requires session_id" }, { status: 400 });
    }

    if (!isWorkerDead) {
      if (!body.lease_token) {
        return NextResponse.json({ error: "lease_token required" }, { status: 400 });
      }
      const [stopCommand] = await db
        .select({
          id: commands.id,
          serverId: commands.serverId,
          type: commands.type,
          payload: commands.payload,
        })
        .from(commands)
        .where(and(eq(commands.id, body.command_id), eq(commands.serverId, server.id)))
        .limit(1);
      const stopPayload = (stopCommand?.payload || {}) as Record<string, unknown>;
      if (
        !stopCommand
        || stopCommand.serverId !== server.id
        || stopCommand.type !== "stop_game"
        || stopPayload.game_id !== body.game_id
        || stopPayload.session_id !== body.session_id
      ) {
        return NextResponse.json({ error: "stop command does not match session game" }, { status: 409 });
      }

    }

    let session: {
      id: string;
      status: string;
      serverId: string | null;
      gameId: string;
    } | undefined;
    [session] = await db
      .select({
        id: sessions.id,
        status: sessions.status,
        serverId: sessions.serverId,
        gameId: sessions.gameId,
      })
      .from(sessions)
      .where(
        and(
          eq(sessions.id, body.session_id),
          eq(sessions.serverId, server.id),
          eq(sessions.gameId, body.game_id),
        ),
      )
      .limit(1);

    if (
      session?.serverId !== server.id
      || session?.gameId !== body.game_id
      || !VALID_TRANSITIONS[session.status]?.includes(SESSION_ENDED)
    ) {
      return NextResponse.json({ error: "active session not found" }, { status: 409 });
    }

    logSignalingStage("stop", "session_resolved", {
      game_id: body.game_id,
      session_id: session.id,
      session_status: session.status,
    });
    try {
      await db.transaction(async (tx) => {
        const [ended] = await tx
          .update(sessions)
          .set({ status: SESSION_ENDED, endedAt: new Date(), stateEnteredAt: new Date() })
          .where(and(
            eq(sessions.id, session.id),
            eq(sessions.serverId, server.id),
            eq(sessions.gameId, body.game_id!),
            eq(sessions.status, session.status),
          ))
          .returning({ id: sessions.id });
        if (!ended) throw new NotifyConflict("session");

        if (!isWorkerDead) {
          const [lease] = await tx
            .update(commands)
            .set({ status: STATUS_COMPLETED, completedAt: new Date(), lastError: null })
            .where(and(
              eq(commands.id, body.command_id),
              eq(commands.serverId, server.id),
              eq(commands.status, STATUS_LEASED),
              eq(commands.leaseToken, body.lease_token!),
            ))
            .returning({ id: commands.id });
          if (!lease) throw new NotifyConflict("lease");
        }
      });
    } catch (error) {
      if (error instanceof NotifyConflict) {
        const message = error.kind === "lease" ? "command lease not found" : "session state changed";
        return NextResponse.json({ error: message }, { status: 409 });
      }
      throw error;
    }

    return NextResponse.json({ ok: true });
  }

  // Verify this server owns the command
  const [cmd] = await db
    .select({ id: commands.id, serverId: commands.serverId, workerToken: commands.workerToken, type: commands.type, payload: commands.payload })
    .from(commands)
    .where(and(eq(commands.id, body.command_id), eq(commands.serverId, server.id)))
    .limit(1);

  notifyFlow = effectiveAction === "stop"
    ? "stop"
    : cmd
      ? (cmd.type === "sdp_offer"
          ? (((cmd.payload as Record<string, unknown> | null)?.peer_token || (cmd.payload as Record<string, unknown> | null)?.room_token) ? "guest_offer" : "host_reconnect")
          : "host_start")
      : "notify";

  if (!cmd || cmd.serverId !== server.id) {
    return NextResponse.json({ error: "command not found" }, { status: 404 });
  }
  const commandPayload = (cmd.payload || {}) as Record<string, unknown>;

  // ── ROM transfer branch: no sessions, no game_id ──────────────────
  if (cmd.type === "rom_transfer") {
    if (!body.lease_token) {
      return NextResponse.json({ error: "lease_token required" }, { status: 400 });
    }
    const transferId = commandPayload.transfer_id;
    if (typeof transferId !== "string" || !transferId) {
      return NextResponse.json({ error: "invalid transfer command" }, { status: 409 });
    }

    const leaseToken = body.lease_token; // narrowed after guard above

    if (body.sdp_answer) {
      await db.transaction(async (tx) => {
        await tx
          .update(commands)
          .set({ sdpAnswer: body.sdp_answer })
          .where(and(eq(commands.id, body.command_id), eq(commands.serverId, server.id)));
        const [lease] = await tx
          .update(commands)
          .set({ status: STATUS_COMPLETED, completedAt: new Date(), lastError: null })
          .where(and(
            eq(commands.id, body.command_id),
            eq(commands.serverId, server.id),
            eq(commands.status, STATUS_LEASED),
            eq(commands.leaseToken, leaseToken),
          ))
          .returning({ id: commands.id });
        if (!lease) throw new NotifyConflict("lease");
      });
    }

    return NextResponse.json({ ok: true, transfer_id: transferId });
  }

  // ── Game session branch (existing path) ───────────────────────────
  if (!body.worker_url || !body.game_id) {
    return NextResponse.json({ error: "game notifications require worker_url and game_id" }, { status: 400 });
  }
  if (commandPayload.game_id !== body.game_id) {
    return NextResponse.json({ error: "command does not match game" }, { status: 409 });
  }

  const commandSessionId = commandPayload.session_id;
  if (
    typeof commandSessionId !== "string"
    || typeof body.session_id !== "string"
    || body.session_id !== commandSessionId
  ) {
    return NextResponse.json({ error: "exact command session_id required" }, { status: 409 });
  }

  // The exact lease is completed in the same transaction as the session mutation.
  if (!body.lease_token) {
    return NextResponse.json({ error: "lease_token required" }, { status: 400 });
  }
  const leaseToken: string = body.lease_token;

  // ── Find or update session ────────────────────────────────────────────
  //
  //  Lookup order: session_id (most precise) → command_id → game_id+server_id.
  //  When updating by game_id fallback, reject if a newer generation exists
  //  (prevents stale worker_dead / SDP answers from updating newer sessions).

  let bySession: {
    id: string;
    status: string;
    roomToken: string | null;
    hostToken: string | null;
    generation: number;
    serverId: string | null;
    gameId: string;
    commandId: string | null;
  } | undefined;

  if (body.session_id) {
    [bySession] = await db
      .select({
        id: sessions.id,
        status: sessions.status,
        roomToken: sessions.roomToken,
        hostToken: sessions.hostToken,
        generation: sessions.generation,
        serverId: sessions.serverId,
        gameId: sessions.gameId,
        commandId: sessions.commandId,
      })
      .from(sessions)
      .where(and(eq(sessions.id, body.session_id), eq(sessions.serverId, server.id)))
      .limit(1);
  }

  if (bySession && (
    bySession.serverId !== server.id
    || bySession.gameId !== body.game_id
    || bySession.id !== commandSessionId
  )) {
    return NextResponse.json({ error: "session does not match callback command" }, { status: 409 });
  }

  // Determine target state
  // Invariant: worker HTTP readiness promotes spawning -> ready.
  // An SDP answer promotes the signaling path into connected.
  const targetStatus = body.sdp_answer ? SESSION_CONNECTED : SESSION_READY;
  logSignalingStage(notifyFlow, "target_status_computed", {
    command_id: body.command_id,
    game_id: body.game_id,
    target_status: targetStatus,
  });

  let roomToken = bySession?.roomToken || randomBytes(16).toString("hex");

  if (bySession) {
    // Invariant: when session_id/command_id hits, update that exact session row.
    // Keep room_token stable across host reconnects and guest SDP renegotiations.
    logSignalingStage(notifyFlow, "session_resolved", {
      command_id: body.command_id,
      game_id: body.game_id,
      resolution: "session_or_command",
      session_id: bySession.id,
      session_status: bySession.status,
    });
    const exactTargetStatus = notifyTargetStatus(bySession.status, !!body.sdp_answer);
    if (!exactTargetStatus) {
      return NextResponse.json({ error: "invalid session state transition" }, { status: 409 });
    }
    try {
      await db.transaction(async (tx) => {
        const [updatedSession] = await tx
          .update(sessions)
          .set({
            workerUrl: body.worker_url,
            status: exactTargetStatus,
            roomToken,
            sdpAnswer: body.sdp_answer ?? null,
            stateEnteredAt: new Date(),
          })
          .where(and(
            eq(sessions.id, bySession.id),
            eq(sessions.serverId, server.id),
            eq(sessions.status, bySession.status),
          ))
          .returning({ id: sessions.id });
        if (!updatedSession) throw new NotifyConflict("session");

        if (body.sdp_answer) {
          await tx
            .update(commands)
            .set({ sdpAnswer: body.sdp_answer })
            .where(and(eq(commands.id, body.command_id), eq(commands.serverId, server.id)));
        }
        const [lease] = await tx
          .update(commands)
          .set({ status: STATUS_COMPLETED, completedAt: new Date(), lastError: null })
          .where(and(
            eq(commands.id, body.command_id),
            eq(commands.serverId, server.id),
            eq(commands.status, STATUS_LEASED),
            eq(commands.leaseToken, leaseToken),
          ))
          .returning({ id: commands.id });
        if (!lease) throw new NotifyConflict("lease");
      });
    } catch (error) {
      if (error instanceof NotifyConflict) {
        const message = error.kind === "lease" ? "command lease not found" : "session state changed";
        return NextResponse.json({ error: message }, { status: 409 });
      }
      throw error;
    }
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
        serverId: sessions.serverId,
        status: sessions.status,
        commandId: sessions.commandId,
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

    const fallbackCapabilityMatches = byGame && (
      byGame.commandId === cmd.id
      || (typeof commandPayload.room_token === "string" && commandPayload.room_token === byGame.roomToken)
      || (typeof commandPayload.host_token === "string" && commandPayload.host_token === byGame.hostToken)
    );
    if (byGame && byGame.serverId === server.id && fallbackCapabilityMatches) {
      logSignalingStage(notifyFlow, "session_resolved", {
        command_id: body.command_id,
        game_id: body.game_id,
        resolution: "game_fallback",
        session_id: byGame.id,
        session_status: byGame.status,
      });
      // Reject stale updates: if a newer generation exists and this notify
      // doesn't explicitly target the current generation, skip the update.
      // This prevents an old worker's SDP answer from overwriting a new session.
      const fallbackTargetStatus = notifyTargetStatus(byGame.status, !!body.sdp_answer);
      if (!fallbackTargetStatus) {
        return NextResponse.json(
          { ok: false, error: "invalid session state transition" },
          { status: 409 },
        );
      }

      roomToken = byGame.roomToken || roomToken;
      try {
        await db.transaction(async (tx) => {
          const [updatedFallback] = await tx
            .update(sessions)
            .set({
              workerUrl: body.worker_url,
              status: fallbackTargetStatus,
              roomToken,
              sdpAnswer: body.sdp_answer ?? null,
              stateEnteredAt: new Date(),
            })
            .where(and(
              eq(sessions.id, byGame.id),
              eq(sessions.serverId, server.id),
              eq(sessions.status, byGame.status),
            ))
            .returning({ id: sessions.id });
          if (!updatedFallback) throw new NotifyConflict("session");

          if (body.sdp_answer) {
            await tx
              .update(commands)
              .set({ sdpAnswer: body.sdp_answer })
              .where(and(eq(commands.id, body.command_id), eq(commands.serverId, server.id)));
          }
          const [lease] = await tx
            .update(commands)
            .set({ status: STATUS_COMPLETED, completedAt: new Date(), lastError: null })
            .where(and(
              eq(commands.id, body.command_id),
              eq(commands.serverId, server.id),
              eq(commands.status, STATUS_LEASED),
              eq(commands.leaseToken, leaseToken),
            ))
            .returning({ id: commands.id });
          if (!lease) throw new NotifyConflict("lease");
        });
      } catch (error) {
        if (error instanceof NotifyConflict) {
          const message = error.kind === "lease" ? "command lease not found" : "session state changed";
          return NextResponse.json({ error: message }, { status: 409 });
        }
        throw error;
      }
    } else {
      if (byGame && byGame.status !== SESSION_ENDED) {
        // Only reject if the existing session is still active. Ended sessions
        // are dead — a new start_game (resident or otherwise) should create a
        // fresh session row.
        return NextResponse.json({ error: "session does not match callback command" }, { status: 409 });
      }
      logSignalingStage(notifyFlow, "session_missing_creating_legacy_row", {
        command_id: body.command_id,
        game_id: body.game_id,
      });
      if (cmd.type !== "start_game") {
        return NextResponse.json({ error: "active session not found" }, { status: 409 });
      }
      // A leased start command may create its initial session as a legacy edge case.
      try {
        const hostToken = typeof commandPayload.host_token === "string" ? commandPayload.host_token : null;
        await db.transaction(async (tx) => {
          await tx.insert(sessions).values({
            userId: server.userId,
            serverId: server.id,
            gameId: body.game_id!,
            commandId: body.command_id,
            hostToken,
            workerUrl: body.worker_url,
            status: targetStatus,
            roomToken,
            sdpAnswer: body.sdp_answer ?? null,
            stateEnteredAt: new Date(),
          });
          if (body.sdp_answer) {
            await tx
              .update(commands)
              .set({ sdpAnswer: body.sdp_answer })
              .where(and(eq(commands.id, body.command_id), eq(commands.serverId, server.id)));
          }
          const [lease] = await tx
            .update(commands)
            .set({ status: STATUS_COMPLETED, completedAt: new Date(), lastError: null })
            .where(and(
              eq(commands.id, body.command_id),
              eq(commands.serverId, server.id),
              eq(commands.status, STATUS_LEASED),
              eq(commands.leaseToken, leaseToken),
            ))
            .returning({ id: commands.id });
          if (!lease) throw new NotifyConflict("lease");
        });
      } catch (error) {
        if (error instanceof NotifyConflict) {
          return NextResponse.json({ error: "command lease not found" }, { status: 409 });
        }
        throw error;
      }
    }
  }

  // ── Record launch timeline event ────────────────────────────────────
  if (body.sdp_answer) {
    logSignalingStage(notifyFlow, "sdp_answer_persisted", {
      command_id: body.command_id,
      game_id: body.game_id,
      session_id: body.session_id ?? null,
      target_status: targetStatus,
    });
    await recordLaunchEvent({
      commandId: body.command_id,
      serverId: server.id,
      gameId: body.game_id,
      sessionId: body.session_id ?? null,
      source: "sc-web",
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
      source: "sc-web",
      event: "worker_http_ready",
      detail: { worker_url: body.worker_url },
    });
  }

  return NextResponse.json({ ok: true, room_token: roomToken });
}

// Legacy GET polling is intentionally disabled: bearer capabilities must never appear in URLs.
export async function GET() {
  return NextResponse.json({ error: "use POST /api/server/notify/poll" }, { status: 405 });
}
