// Periodic cleanup of stale database rows.
//
// Commands and sessions accumulate forever without cleanup.
// This runs every 60s and:
//   - Deletes commands delivered > 1h ago
//   - Deletes sessions ended > 1h ago
//   - Transitions stuck sessions to timed_out (>60s in spawning/ready/connected)

import { db } from "@/lib/db";
import { commands, launchEvents, peerTokens, sessions } from "@/lib/db/schema";
import { SESSION_STATE_TIMEOUT_MS, SESSION_SPAWNING, SESSION_READY, SESSION_CONNECTED } from "@/lib/constants";
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
    await database
      .update(sessions)
      .set({ status: "timed_out", endedAt: new Date() })
      .where(
        and(
          lt(sessions.stateEnteredAt, timeoutCutoff),
          inArray(sessions.status, STUCK_STATES),
        ),
      );

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
          lt(commands.createdAt, commandCutoff),
          sql`not exists (select 1 from ${sessions} where ${sessions.commandId} = ${commands.id})`,
          sql`not exists (select 1 from ${launchEvents} where ${launchEvents.commandId} = ${commands.id})`,
        ),
      );
  } catch (e) {
    console.error(JSON.stringify({ service: "gv-web", level: "error", msg: "cleanup error", error: String(e) }));
  }
}

let _started = false;

export function startCleanup() {
  if (_started) return;

  // Skip during Next.js build phase — no DB connection available.
  if (process.env.NEXT_PHASE === "phase-production-build") return;

  _started = true;

  // Run once at startup
  cleanupOnce();

  setInterval(cleanupOnce, CLEANUP_INTERVAL_MS);
}

// Export startCleanup for explicit scheduling (cron, systemd timer, or
// Docker sidecar). Importing this module does NOT start a cleanup loop.
