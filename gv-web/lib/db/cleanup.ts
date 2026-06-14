// Periodic cleanup of stale database rows.
//
// Commands and sessions accumulate forever without cleanup.
// This runs every 60s and deletes:
//   - Commands delivered > 1h ago
//   - Sessions ended (stopped) > 1h ago
//
// Cleanup is fire-and-forget — failures are logged, not fatal.

import { db } from "@/lib/db";
import { commands, sessions } from "@/lib/db/schema";
import { and, lt, ne } from "drizzle-orm";

const CLEANUP_INTERVAL_MS = 60_000;
const COMMAND_RETENTION_MS = 3_600_000; // 1 hour
const SESSION_RETENTION_MS = 3_600_000; // 1 hour

async function cleanupOnce() {
  try {
    const commandCutoff = new Date(Date.now() - COMMAND_RETENTION_MS);
    await db
      .delete(commands)
      .where(
        and(
          ne(commands.status, "pending"),
          lt(commands.createdAt, commandCutoff),
        ),
      );

    const sessionCutoff = new Date(Date.now() - SESSION_RETENTION_MS);
    await db.delete(sessions).where(lt(sessions.endedAt, sessionCutoff));
  } catch (e) {
    console.error(JSON.stringify({ service: "gv-web", level: "error", msg: "cleanup error", error: String(e) }));
  }
}

let _started = false;

export function startCleanup() {
  if (_started) return;
  _started = true;

  // Run once at startup
  cleanupOnce();

  setInterval(cleanupOnce, CLEANUP_INTERVAL_MS);
}

// Auto-start when the module is first imported (server startup).
startCleanup();
