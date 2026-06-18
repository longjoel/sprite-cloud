// Periodic cleanup of stale database rows.
//
// Commands and sessions accumulate forever without cleanup.
// This runs every 60s and:
//   - Deletes commands delivered > 1h ago
//   - Deletes sessions ended > 1h ago
//   - Transitions stuck sessions to timed_out (>60s in spawning/ready/connected)

import { db } from "@/lib/db";
import { commands, sessions } from "@/lib/db/schema";
import { SESSION_STATE_TIMEOUT_MS, SESSION_SPAWNING, SESSION_READY, SESSION_CONNECTED } from "@/lib/constants";
import { and, lt, ne, inArray } from "drizzle-orm";

const CLEANUP_INTERVAL_MS = 60_000;
const COMMAND_RETENTION_MS = 3_600_000; // 1 hour
const SESSION_RETENTION_MS = 3_600_000; // 1 hour

const STUCK_STATES = [SESSION_SPAWNING, SESSION_READY, SESSION_CONNECTED];

async function cleanupOnce() {
  try {
    // ── Delete old commands ──────────────────────────────────────────
    const commandCutoff = new Date(Date.now() - COMMAND_RETENTION_MS);
    await db
      .delete(commands)
      .where(
        and(
          ne(commands.status, "pending"),
          lt(commands.createdAt, commandCutoff),
        ),
      );

    // ── Delete old ended sessions ────────────────────────────────────
    const sessionCutoff = new Date(Date.now() - SESSION_RETENTION_MS);
    await db.delete(sessions).where(lt(sessions.endedAt, sessionCutoff));

    // ── Time out stuck sessions ─────────────────────────────────────
    const timeoutCutoff = new Date(Date.now() - SESSION_STATE_TIMEOUT_MS);
    await db
      .update(sessions)
      .set({ status: "timed_out", endedAt: new Date(), roomToken: null })
      .where(
        and(
          lt(sessions.stateEnteredAt, timeoutCutoff),
          inArray(sessions.status, STUCK_STATES),
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

// Auto-start when the module is first imported (server startup).
// Guarded above to skip during build.
startCleanup();
