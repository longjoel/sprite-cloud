// Periodic cleanup of stale database rows.
//
// Commands and sessions accumulate forever without cleanup.
// This runs every 60s and:
//   - Deletes commands delivered > 1h ago
//   - Deletes sessions ended > 1h ago
//   - Transitions stuck sessions to timed_out (>60s in spawning/ready/connected)

import { db } from "@/lib/db";
import { commands, launchEvents, peerTokens, sessions, servers } from "@/lib/db/schema";
import { SESSION_STATE_TIMEOUT_MS, SESSION_SPAWNING, SESSION_READY, SESSION_CONNECTED } from "@/lib/constants";
import { commandSessionId } from "@/lib/command-payload";
import { and, lt, ne, inArray, notInArray, sql } from "drizzle-orm";

const CLEANUP_INTERVAL_MS = 60_000;
const COMMAND_RETENTION_MS = 3_600_000; // 1 hour
const SESSION_RETENTION_MS = 3_600_000; // 1 hour

const STUCK_STATES = [SESSION_SPAWNING, SESSION_READY, SESSION_CONNECTED];


export async function cleanupOnce(database = db) {
  try {
    const now = Date.now();

    // ── Time out stuck sessions ─────────────────────────────────────
    const timeoutCutoff = new Date(now - SESSION_STATE_TIMEOUT_MS);
    await database.transaction(async (tx) => {
      const staleServerRows = await tx
        .select({ serverId: sessions.serverId })
        .from(sessions)
        .where(and(
          lt(sessions.stateEnteredAt, timeoutCutoff),
          inArray(sessions.status, STUCK_STATES),
        ));
      const staleServerIds = Array.from(new Set(
        staleServerRows.map((row) => row.serverId).filter((id): id is string => !!id),
      )).sort();
      if (staleServerIds.length === 0) return;

      // Serialize with /poll's server-row lock, then re-evaluate eligibility.
      // No command can be leased between convergence and session timeout.
      await tx
        .select({ id: servers.id })
        .from(servers)
        .where(inArray(servers.id, staleServerIds))
        .orderBy(servers.id)
        .for("update");

      const staleRows = await tx
        .select({ id: sessions.id })
        .from(sessions)
        .where(and(
          lt(sessions.stateEnteredAt, timeoutCutoff),
          inArray(sessions.status, STUCK_STATES),
          inArray(sessions.serverId, staleServerIds),
        ));
      const staleIds = new Set(staleRows.map((row) => row.id));
      const lifecycleRows = await tx
        .select({
          id: commands.id,
          type: commands.type,
          payload: commands.payload,
          status: commands.status,
          leaseExpiresAt: commands.leaseExpiresAt,
        })
        .from(commands)
        .where(and(
          inArray(commands.serverId, staleServerIds),
          inArray(commands.type, ["start_game", "stop_game", "sdp_offer"]),
          inArray(commands.status, ["pending", "leased", "failed"]),
        ));
      const activeSessionIds = new Set(lifecycleRows
        .filter((row) =>
          (row.type === "stop_game" && ["pending", "leased", "failed"].includes(row.status))
          || (row.status === "leased" && row.leaseExpiresAt && row.leaseExpiresAt.getTime() >= now),
        )
        .map((row) => commandSessionId(row.payload))
        .filter((id): id is string => !!id));
      const eligibleIds = [...staleIds].filter((id) => !activeSessionIds.has(id));
      if (eligibleIds.length === 0) return;

      const retryableRows = lifecycleRows.filter((row) => {
        const sessionId = commandSessionId(row.payload);
        const leaseExpired = row.status === "pending"
          || (row.status === "leased" && !!row.leaseExpiresAt && row.leaseExpiresAt.getTime() < now);
        return !!sessionId && eligibleIds.includes(sessionId) && leaseExpired;
      });
      const failedIds = retryableRows
        .filter((row) => row.type === "start_game" || row.type === "sdp_offer")
        .map((row) => row.id);

      if (failedIds.length > 0) await tx.update(commands)
        .set({
          status: "failed",
          completedAt: new Date(),
          lastError: "target session timed out",
          result: { error: "session_timed_out" },
          leaseToken: null,
          leaseExpiresAt: null,
        })
        .where(inArray(commands.id, failedIds));
      await tx.update(sessions)
        .set({ status: "timed_out", endedAt: new Date() })
        .where(and(
          inArray(sessions.id, eligibleIds),
          lt(sessions.stateEnteredAt, timeoutCutoff),
          inArray(sessions.status, STUCK_STATES),
        ));
    });

    const commandCutoff = new Date(now - COMMAND_RETENTION_MS);
    const sessionCutoff = new Date(now - SESSION_RETENTION_MS);

    // ── Delete old launch telemetry first ────────────────────────────
    // launch_events references both sessions and commands, so it must be
    // removed before either parent table can be pruned.
    await database.delete(launchEvents).where(lt(launchEvents.createdAt, commandCutoff));

    // ── Delete stale/orphaned peer tokens ────────────────────────────
    // peer_tokens with no matching session (session was deleted above,
    // or deleted by other means). Also clean up tokens for ended sessions
    // that haven't been deleted yet — these stale rows inflate the seat
    // count in room/join.
    await database.delete(peerTokens).where(
      inArray(
        peerTokens.sessionId,
        database.select({ id: sessions.id }).from(sessions).where(lt(sessions.endedAt, sessionCutoff)),
      ),
    );
    await database.delete(peerTokens).where(
      notInArray(
        peerTokens.sessionId,
        database.select({ id: sessions.id }).from(sessions),
      ),
    );

    // ── Delete old ended/timed-out sessions ──────────────────────────
    await database.delete(sessions).where(lt(sessions.endedAt, sessionCutoff));

    // ── Delete old unreferenced commands ─────────────────────────────
    await database
      .delete(commands)
      .where(
        and(
          ne(commands.status, "pending"),
          sql`(${commands.type} <> 'stop_game' or ${commands.status} in ('completed', 'cancelled'))`,
          lt(commands.createdAt, commandCutoff),
          sql`not exists (select 1 from ${sessions} where ${sessions.commandId} = ${commands.id})`,
          sql`not exists (select 1 from ${launchEvents} where ${launchEvents.commandId} = ${commands.id})`,
        ),
      );
  } catch (e) {
    console.error(JSON.stringify({ service: "sc-web", level: "error", msg: "cleanup error", error: String(e) }));
    throw e;
  }
}

// Importing this module does NOT start cleanup. Run `pnpm run cleanup:once`
// (or invoke cleanupOnce from explicit tooling) instead.
