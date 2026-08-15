import { NextResponse } from "next/server";
import crypto from "crypto";
import { db } from "@/lib/db";
import { commands, sessions, gameFlags, serverGames, servers } from "@/lib/db/schema";
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

type PollExecutor = Pick<typeof db, "select" | "insert" | "update">;

function parseRuntimeTelemetry(raw: string | null): Record<string, number> | null {
  if (!raw || raw.length > 4096) return null;
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const fields = [
      "cpu_percent",
      "memory_total_bytes",
      "memory_available_bytes",
      "memory_used_bytes",
      "memory_used_percent",
      "uptime_seconds",
      "active_session_count",
    ];
    const telemetry: Record<string, number> = {};
    for (const field of fields) {
      const number = value[field];
      if (typeof number !== "number" || !Number.isFinite(number) || number < 0) return null;
      telemetry[field] = number;
    }
    if (telemetry.cpu_percent > 100 || telemetry.memory_used_percent > 100) return null;
    return telemetry;
  } catch {
    return null;
  }
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

  const bootId = request.headers.get("x-sc-server-boot-id");
  let runtimeReset = false;
  if (bootId && isBootId(bootId)) {
    runtimeReset = await resetStaleRuntime(server.id, bootId);
    if (!runtimeReset) {
      return NextResponse.json({ commands: [], next_poll_ms: POLL_IDLE_MS });
    }
  }

  const runtimeTelemetry = parseRuntimeTelemetry(request.headers.get("x-sc-server-telemetry"));
  const now = new Date();
  const leaseExpiresAt = new Date(now.getTime() + COMMAND_LEASE_MS);

  // Fence the entire poll mutation under the server row lock. An older poll
  // that was paused before a newer boot reset must be rejected here, before
  // telemetry, resident convergence, or command leasing can mutate state.
  const leased = await db.transaction(async (tx) => {
    if (bootId && isBootId(bootId)) {
      const [current] = await tx
        .select({ runtimeBootId: servers.runtimeBootId })
        .from(servers)
        .where(eq(servers.id, server.id))
        .limit(1)
        .for("update");
      if (!current || current.runtimeBootId !== bootId) return null;
    }

    if (runtimeTelemetry) {
      await tx
        .update(servers)
        .set({ runtimeTelemetry })
        .where(eq(servers.id, server.id));
    }

    await convergeResidents(tx, server.id, server.userId);

    if (runtimeReset) {
      await tx
        .update(commands)
        .set({
          status: "cancelled",
          completedAt: now,
          lastError: "runtime reset after sc-server restart",
        })
        .where(and(
          eq(commands.serverId, server.id),
          inArray(commands.type, ["start_game", "stop_game", "sdp_offer"]),
          inArray(commands.status, [STATUS_PENDING, STATUS_LEASED]),
          sql`${commands.payload}->>'session_id' IN (
            SELECT id::text FROM sessions
            WHERE server_id = ${server.id} AND status IN ('ended', 'timed_out')
          )`,
        ));
    }

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

  if (leased === null) {
    return NextResponse.json({ commands: [], next_poll_ms: POLL_IDLE_MS });
  }

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

// ── Runtime reset ─────────────────────────────────────────────────────

const BOOT_ID_RE = /^(\d{20})-([0-9a-f]{32})$/;

function isBootId(value: string): boolean {
  return BOOT_ID_RE.test(value);
}

function isNewerBootId(current: string | null | undefined, incoming: string): boolean {
  if (!current) return true;
  const currentMatch = current.match(BOOT_ID_RE);
  const incomingMatch = incoming.match(BOOT_ID_RE);
  if (!incomingMatch) return false;
  if (!currentMatch) return true;
  return incomingMatch[1] > currentMatch[1]
    || (incomingMatch[1] === currentMatch[1] && incoming > current);
}

/**
 * A sc-server process owns all runtime sessions in memory. When a new boot ID
 * arrives, the previous process is gone even though its DB rows may still say
 * connected/playing. End those rows once, cancel their queued signaling, and
 * let resident convergence recreate always-on games.
 */
async function resetStaleRuntime(serverId: string, bootId: string): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [server] = await tx
      .select({ runtimeBootId: servers.runtimeBootId })
      .from(servers)
      .where(eq(servers.id, serverId))
      .limit(1)
      .for("update");
    if (!server) return false;
    if (server.runtimeBootId === bootId) return true;
    if (!isNewerBootId(server.runtimeBootId, bootId)) return false;

    const staleSessions = await tx
      .select({ id: sessions.id, gameId: sessions.gameId })
      .from(sessions)
      .where(and(
        eq(sessions.serverId, serverId),
        inArray(sessions.status, [...ACTIVE_SESSION_STATES]),
      ));

    const now = new Date();
    await tx
      .update(servers)
      .set({ runtimeBootId: bootId })
      .where(eq(servers.id, serverId));

    if (staleSessions.length === 0) return true;

    await tx
      .update(sessions)
      .set({ status: "ended", stateEnteredAt: now, endedAt: now })
      .where(and(
        eq(sessions.serverId, serverId),
        inArray(sessions.id, staleSessions.map((session) => session.id)),
      ));

    const staleSessionIds = new Set(staleSessions.map((session) => session.id));
    const staleCommands = await tx
      .select({ id: commands.id, payload: commands.payload })
      .from(commands)
      .where(and(
        eq(commands.serverId, serverId),
        inArray(commands.type, ["start_game", "stop_game", "sdp_offer"]),
        inArray(commands.status, [STATUS_PENDING, STATUS_LEASED]),
      ));
    const staleCommandIds = staleCommands
      .filter((command) => {
        try {
          const payload = typeof command.payload === "string"
            ? JSON.parse(command.payload) as Record<string, unknown>
            : command.payload as Record<string, unknown>;
          return typeof payload?.session_id === "string" && staleSessionIds.has(payload.session_id);
        } catch {
          return false;
        }
      })
      .map((command) => command.id);
    if (staleCommandIds.length === 0) return true;

    await tx
      .update(commands)
      .set({
        status: "cancelled",
        completedAt: now,
        lastError: "runtime reset after sc-server restart",
      })
      .where(inArray(commands.id, staleCommandIds));
    return true;
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
async function convergeResidents(executor: PollExecutor, serverId: string, userId: string): Promise<void> {
  // Always-on flags that should have active sessions
  const wantedGames = await executor
    .select({
      gameId: gameFlags.gameId,
      maxSeats: gameFlags.maxSeats,
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
  const activeSessions = await executor
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
  const inFlightCommands = await executor
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
    await stopDefunctResidents(executor, serverId, wantedIds);
    return;
  }

  const maxSeatsByGame = new Map(wantedGames.map((g) => [g.gameId, g.maxSeats]));
  for (const gameId of missing) {
    const now = new Date();
    const cmdId = crypto.randomUUID();
    const hostToken = crypto.randomUUID();
    const sessionId = crypto.randomUUID();

    // The outer server-row fence serializes resident convergence across polls.
    const [existingSession] = await executor
      .select({ id: sessions.id })
      .from(sessions)
      .where(and(
        eq(sessions.serverId, serverId),
        eq(sessions.gameId, gameId),
        inArray(sessions.status, [...ACTIVE_SESSION_STATES]),
      ))
      .limit(1);
    if (existingSession) continue;

    const [inFlight] = await executor
      .select({ id: commands.id })
      .from(commands)
      .where(and(
        eq(commands.serverId, serverId),
        eq(commands.type, "start_game"),
        inArray(commands.status, [STATUS_PENDING, STATUS_LEASED]),
        sql`${commands.payload}->>'game_id' = ${gameId}`,
      ))
      .limit(1);
    if (inFlight) continue;

    await executor.insert(commands).values({
      id: cmdId,
      serverId,
      type: "start_game",
      payload: {
        game_id: gameId,
        host_token: hostToken,
        session_id: sessionId,
        resident: true,
        max_seats: maxSeatsByGame.get(gameId) ?? 4,
      },
      status: STATUS_PENDING,
      createdAt: now,
    });
    await executor.insert(sessions).values({
      id: sessionId,
      userId,
      serverId,
      gameId,
      commandId: cmdId,
      hostToken,
      status: "spawning",
      maxSeats: maxSeatsByGame.get(gameId) ?? 4,
      stateEnteredAt: now,
    });
  }

  // Stop any resident sessions whose always_on flag was cleared
  await stopDefunctResidents(executor, serverId, wantedIds);
}

/**
 * Find active sessions that were started with `resident: true` but the
 * underlying game's always_on flag has since been cleared, and issue
 * stop_game commands.
 */
async function stopDefunctResidents(
  executor: PollExecutor,
  serverId: string,
  wantedIds: string[],
): Promise<void> {
  // Active sessions for this server that are NOT in the wanted set
  const orphaned = await executor
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
          ? [sql`${sessions.gameId} NOT IN (${sql.join(wantedIds, sql`, `)})`]
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

  const orphanCmds = await executor
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
  const inFlightStops = await executor
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
    await executor.insert(commands).values({
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
