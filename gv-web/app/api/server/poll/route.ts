import { NextResponse } from "next/server";
import crypto from "crypto";
import { db } from "@/lib/db";
import { commands } from "@/lib/db/schema";
import { verifyBearerToken, unauthorizedResponse } from "@/lib/server-auth";
import {
  POLL_FAST_MS,
  POLL_IDLE_MS,
  STATUS_LEASED,
  STATUS_PENDING,
  COMMAND_LEASE_MS,
} from "@/lib/constants";
import { eq, and, inArray, or, lt, sql } from "drizzle-orm";

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
 * gv-server polls this endpoint (with bearer token) to receive queued
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
      .orderBy(commands.createdAt)
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

  return NextResponse.json({
    commands: leased,
    next_poll_ms: leased.length > 0 ? POLL_FAST_MS : POLL_IDLE_MS,
  });
}
