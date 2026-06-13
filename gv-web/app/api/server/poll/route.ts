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
 * commands.  Pending commands are marked DELIVERED atomically so they
 * are never returned twice.
 *
 * The response includes `next_poll_ms` — 250ms when commands were
 * just delivered (fast follow-up for SDP relay latency), 2000ms idle.
 */
export async function GET(request: Request): Promise<NextResponse<PollResponse>> {
  const server = await verifyBearerToken(request.headers.get("authorization"));
  if (!server) return unauthorizedResponse() as NextResponse<PollResponse>;

  // Fetch + atomically mark delivered in one round-trip
  const pending = await db
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
    .limit(25);

  if (pending.length > 0) {
    // Mark only the fetched commands as delivered (not any that
    // arrived between our SELECT and UPDATE).
    const ids = pending.map((c) => c.id);
    await db
      .update(commands)
      .set({ status: STATUS_DELIVERED })
      .where(inArray(commands.id, ids));
  }

  return NextResponse.json({
    commands: pending,
    next_poll_ms: pending.length > 0 ? POLL_FAST_MS : POLL_IDLE_MS,
  });
}
