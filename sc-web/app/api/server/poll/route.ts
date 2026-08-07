import { NextResponse } from "next/server";
import crypto from "crypto";
import { db } from "@/lib/db";
import { commands, sessions, gameFlags, serverGames } from "@/lib/db/schema";
import { verifyBearerToken, unauthorizedResponse } from "@/lib/server-auth";
import {
  POLL_FAST_MS,
  POLL_IDLE_MS,
  STATUS_LEASED,
  STATUS_PENDING,
  COMMAND_LEASE_MS,
  ACTIVE_SESSION_STATES,
} from "@/lib/constants";
import { eq, and, inArray, or, lt, sql, isNull } from "drizzle-orm";
import { recordLaunchEvent } from "@/lib/launch-events";

// ── Types ──────────────────────────────────────────────────────────────

interface PollResponse {
  commands: Array<{
    id: string;
    type: string;
    payload: unknown;
    lease_token: string;
    lease_expires_at: string;
    attempt: number;
  }>;
  next_poll_ms: number;
}

// ── Handler ────────────────────────────────────────────────────────────

/**
 * GET /api/server/poll
 *
 * sc-server polls this endpoint (with bearer token) to receive queued
 * commands. Pending or expired-lease commands are fetched and leased inside
 * a transaction — SELECT FOR UPDATE locks the rows so concurrent
 * requests can't lease the same command twice.
 *
 * The response includes `next_poll_ms` — 250ms when commands were
 * just delivered (fast follow-up for SDP relay latency), 2000ms idle.
 */
export async function GET(request: Request): Promise<NextResponse<PollResponse>> {
  const server = await verifyBearerToken(request.headers.get("authorization"));
  if (!server) return unauthorizedResponse() as NextResponse<PollResponse>;

  // ── Resident convergence ──────────────────────────────────────────
  // Converge the resident (always_on) game set on every poll tick.
  // Idempotent — does not create duplicate commands.
  await convergeResidents(server.id);

  const now = new Date();
  const leaseExpiresAt = new Date(now.getTime() + COMMAND_LEASE_MS);

  // Fetch + atomically lease in one transaction.
  // SELECT … FOR UPDATE locks the rows until the UPDATE commits,
  // preventing concurrent requests from double-leasing.
  const leased = await db.transaction(async (tx) => {
    const rows = await tx
      .select({
        id: commands.id,
        type: commands.type,
        payload: commands.payload,
        attempts: commands.attempts,
      })
      .from(commands)
      .where(
        and(
          eq(commands.serverId, server.id),
          or(
            eq(commands.status, STATUS_PENDING),
            and(
              eq(commands.status, STATUS_LEASED),
              lt(commands.leaseExpiresAt, now),
            ),
          ),
        ),
      )
      .orderBy(
        sql`case ${commands.type}
          when 'sdp_offer' then 0
          when 'stop_game' then 1
          when 'start_game' then 2
          else 3
        end`,
        commands.createdAt,
      )
      .limit(25)
      .for("update");

    if (rows.length === 0) return [];

    const ids = rows.map((c) => c.id);
    const leaseToken = crypto.randomBytes(16).toString("hex");
    await tx
      .update(commands)
      .set({
        status: STATUS_LEASED,
        leaseToken,
        leasedAt: now,
        leaseExpiresAt,
        attempts: sql`${commands.attempts} + 1`,
      })
      .where(inArray(commands.id, ids));

    return rows.map((row) => ({
      id: row.id,
      type: row.type,
      payload: row.payload,
      lease_token: leaseToken,
      lease_expires_at: leaseExpiresAt.toISOString(),
      attempt: (row.attempts ?? 0) + 1,
    }));
  });

  await Promise.all(
    leased.map((cmd) => {
      const payload = cmd.payload && typeof cmd.payload === "object" && !Array.isArray(cmd.payload)
        ? cmd.payload as Record<string, unknown>
        : {};
      return recordLaunchEvent({
        commandId: cmd.id,
        serverId: server.id,
        gameId: typeof payload.game_id === "string" ? payload.game_id : null,
        source: "sc-web",
        event: "command_leased",
        detail: { command_type: cmd.type, attempt: cmd.attempt },
      });
    }),
  );

  return NextResponse.json({
    commands: leased,
    next_poll_ms: leased.length > 0 ? POLL_FAST_MS : POLL_IDLE_MS,
  });
}

// ── Resident convergence ──────────────────────────────────────────────

/**
 * Ensure every game flagged `always_on` has an active session.
 * Creates `start_game {resident: true}` commands for missing games
 * and `stop_game` for sessions whose always_on flag was cleared.
 *
 * Called on every poll tick — idempotent (skips games that already
 * have a resident command in flight or an active session).
 */
async function convergeResidents(serverId: string): Promise<void> {
  // Always-on flags that should have active sessions
  const wantedGames = await db
    .select({
      gameId: gameFlags.gameId,
    })
    .from(gameFlags)
    .where(
      and(
        eq(gameFlags.serverId, serverId),
        eq(gameFlags.alwaysOn, true),
      ),
    );

  if (wantedGames.length === 0) return;
  const wantedIds = wantedGames.map((g) => g.gameId);

  // Already-active sessions for these games — skip
  const activeSessions = await db
    .select({ gameId: sessions.gameId })
    .from(sessions)
    .where(
      and(
        eq(sessions.serverId, serverId),
        inArray(sessions.gameId, wantedIds),
        inArray(sessions.status, [...ACTIVE_SESSION_STATES]),
      ),
    );
  const activeIds = new Set(activeSessions.map((s) => s.gameId));

  // Commands already in-flight for these games (pending or leased)
  const inFlightCommands = await db
    .select({ gameId: commands.payload })
    .from(commands)
    .where(
      and(
        eq(commands.serverId, serverId),
        eq(commands.type, "start_game"),
        inArray(commands.status, [STATUS_PENDING, STATUS_LEASED]),
      ),
    );
  const inFlightIds = new Set(
    inFlightCommands
      .map((c) => {
        try {
          const p = typeof c.gameId === "string" ? JSON.parse(c.gameId) : c.gameId;
          return (p as Record<string, unknown>)?.game_id as string | undefined;
        } catch {
          return undefined;
        }
      })
      .filter((id): id is string => typeof id === "string" && wantedIds.includes(id)),
  );

  // Create start_game for games that are wanted but not active and not in-flight
  const missing = wantedIds.filter((id) => !activeIds.has(id) && !inFlightIds.has(id));
  if (missing.length === 0 && wantedIds.length > 0) {
    // Nothing to start — but we still need to check for stale resident sessions
    // to stop (games whose always_on flag was turned off).
    await stopDefunctResidents(serverId, wantedIds);
    return;
  }

  const now = new Date();
  for (const gameId of missing) {
    const cmdId = crypto.randomUUID();
    const hostToken = crypto.randomUUID();
    const sessionId = crypto.randomUUID();
    await db.insert(commands).values({
      id: cmdId,
      serverId,
      type: "start_game",
      payload: {
        game_id: gameId,
        host_token: hostToken,
        session_id: sessionId,
        resident: true,
        max_seats: 4,
      },
      status: STATUS_PENDING,
      createdAt: now,
    });
  }

  // Stop any resident sessions whose always_on flag was cleared
  await stopDefunctResidents(serverId, wantedIds);
}

/**
 * Find active sessions that were started with `resident: true` but the
 * underlying game's always_on flag has since been cleared, and issue
 * stop_game commands.
 */
async function stopDefunctResidents(
  serverId: string,
  wantedIds: string[],
): Promise<void> {
  // Active sessions for this server that are NOT in the wanted set
  const orphaned = await db
    .select({
      sessionId: sessions.id,
      gameId: sessions.gameId,
      hostToken: sessions.hostToken,
      commandId: sessions.commandId,
    })
    .from(sessions)
    .where(
      and(
        eq(sessions.serverId, serverId),
        ...(wantedIds.length
          ? [sql`${sessions.gameId} NOT IN (${sql.join(wantedIds)})`]
          : [sql`TRUE`]),
        inArray(sessions.status, [...ACTIVE_SESSION_STATES]),
      ),
    );

  if (orphaned.length === 0) return;

  // Only stop sessions that were created from a resident start_game command
  const orphanCmdIds = orphaned
    .map((s) => s.commandId)
    .filter((id): id is string => id !== null);

  if (orphanCmdIds.length === 0) return;

  const orphanCmds = await db
    .select({ id: commands.id, payload: commands.payload })
    .from(commands)
    .where(inArray(commands.id, orphanCmdIds));

  const residentCmdIds = new Set(
    orphanCmds
      .filter((c) => {
        try {
          const p =
            typeof c.payload === "string"
              ? JSON.parse(c.payload)
              : c.payload;
          return (p as Record<string, unknown>)?.resident === true;
        } catch {
          return false;
        }
      })
      .map((c) => c.id),
  );

  const toStop = orphaned.filter((s) => residentCmdIds.has(s.commandId!));

  // Don't stop if there's already a stop_game in-flight
  const inFlightStops = await db
    .select({ gameId: commands.payload })
    .from(commands)
    .where(
      and(
        eq(commands.serverId, serverId),
        eq(commands.type, "stop_game"),
        inArray(commands.status, [STATUS_PENDING, STATUS_LEASED]),
      ),
    );

  const inFlightStopIds = new Set(
    inFlightStops
      .map((c) => {
        try {
          const p =
            typeof c.gameId === "string"
              ? JSON.parse(c.gameId)
              : c.gameId;
          return (p as Record<string, unknown>)?.game_id as string | undefined;
        } catch {
          return undefined;
        }
      })
      .filter((id): id is string => typeof id === "string"),
  );

  const now = new Date();
  for (const s of toStop) {
    if (inFlightStopIds.has(s.gameId)) continue;
    await db.insert(commands).values({
      id: crypto.randomUUID(),
      serverId,
      type: "stop_game",
      payload: JSON.stringify({
        game_id: s.gameId,
        host_token: s.hostToken,
        session_id: s.sessionId,
      }),
      status: STATUS_PENDING,
      createdAt: now,
    });
  }
}
