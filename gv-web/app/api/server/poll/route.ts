import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { commands } from "@/lib/db/schema";
import { verifyBearerToken, unauthorizedResponse } from "@/lib/server-auth";
import {
  POLL_FAST_MS,
  POLL_IDLE_MS,
  STATUS_DELIVERED,
  STATUS_PENDING,
} from "@/lib/constants";
import { eq, and, inArray } from "drizzle-orm";

// ── Types ──────────────────────────────────────────────────────────────

interface PollResponse {
  commands: Array<{
    id: string;
    type: string;
    payload: unknown;
  }>;
  next_poll_ms: number;
}

// ── Handler ────────────────────────────────────────────────────────────

/**
 * GET /api/server/poll
 *
 * gv-server polls this endpoint (with bearer token) to receive queued
 * commands.  Pending commands are fetched and marked DELIVERED inside
 * a transaction — SELECT FOR UPDATE locks the rows so concurrent
 * requests can't deliver the same command twice.
 *
 * The response includes `next_poll_ms` — 250ms when commands were
 * just delivered (fast follow-up for SDP relay latency), 2000ms idle.
 */
export async function GET(request: Request): Promise<NextResponse<PollResponse>> {
  const server = await verifyBearerToken(request.headers.get("authorization"));
  if (!server) return unauthorizedResponse() as NextResponse<PollResponse>;

  // Fetch + atomically mark delivered in one transaction.
  // SELECT … FOR UPDATE locks the rows until the UPDATE commits,
  // preventing concurrent requests from double-delivering.
  const pending = await db.transaction(async (tx) => {
    const rows = await tx
      .select({
        id: commands.id,
        type: commands.type,
        payload: commands.payload,
      })
      .from(commands)
      .where(
        and(
          eq(commands.serverId, server.id),
          eq(commands.status, STATUS_PENDING),
        ),
      )
      .orderBy(commands.createdAt)
      .limit(25)
      .for("update");

    if (rows.length > 0) {
      const ids = rows.map((c) => c.id);
      await tx
        .update(commands)
        .set({ status: STATUS_DELIVERED })
        .where(inArray(commands.id, ids));
    }

    return rows;
  });

  return NextResponse.json({
    commands: pending,
    next_poll_ms: pending.length > 0 ? POLL_FAST_MS : POLL_IDLE_MS,
  });
}
