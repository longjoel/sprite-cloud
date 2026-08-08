import { randomBytes } from "crypto";
import { and, eq, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { peerTokens } from "@/lib/db/schema";

export interface RoomPeerInput {
  sessionId: string;
  clientId: string;
  maxSeats: number;
  /** Wall-tile preview: mint a viewer token with a spectator seat beyond
   *  maxSeats — never consumes a player slot, always spectator capabilities. */
  preview?: boolean;
}

export interface IssuedRoomPeer {
  token: string;
  seat: number;
  role: "player" | "viewer";
  reused: boolean;
}

export interface RoomPeerIssueHooks {
  /** Test synchronization hook; production callers leave this unset. */
  afterLockAcquired?: () => Promise<void>;
}

/**
 * Issue one stable peer capability while serializing seat allocation per session.
 * The transaction lock prevents concurrent guests from claiming the same final
 * player seat and exceeding the session's player capacity.
 */
export async function issueRoomPeer<TSchema extends Record<string, unknown>>(
  database: PostgresJsDatabase<TSchema>,
  input: RoomPeerInput,
  hooks: RoomPeerIssueHooks = {},
): Promise<IssuedRoomPeer> {
  return database.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${input.sessionId}, 0))`,
    );
    await hooks.afterLockAcquired?.();

    const [existingPeer] = await tx
      .select({ token: peerTokens.token, seat: peerTokens.seat, role: peerTokens.role })
      .from(peerTokens)
      .where(and(
        eq(peerTokens.sessionId, input.sessionId),
        eq(peerTokens.clientId, input.clientId),
      ))
      .limit(1);

    if (existingPeer) {
      return {
        token: existingPeer.token,
        seat: existingPeer.seat,
        role: existingPeer.role === "player" ? "player" : "viewer",
        reused: true,
      };
    }

    // Preview joins are always spectators: they get a seat beyond the
    // player capacity so the wall tile's WebRTC leg never occupies a
    // playable slot. Reuse the same spectator seat for all previews so
    // preview tokens don't push real viewers' seats higher over time.
    if (input.preview) {
      const seat = input.maxSeats + 1;
      const token = randomBytes(16).toString("hex");
      await tx.insert(peerTokens).values({
        sessionId: input.sessionId,
        token,
        seat,
        role: "viewer",
        clientId: input.clientId,
      });
      return { token, seat, role: "viewer", reused: false };
    }

    const [maxResult] = await tx
      .select({ max: sql<number>`coalesce(max(${peerTokens.seat}), 0)` })
      .from(peerTokens)
      .where(eq(peerTokens.sessionId, input.sessionId));
    const seat = (maxResult?.max ?? 0) + 1;
    // maxSeats is the player capacity: seats 1..maxSeats are players,
    // any further seats are spectators (#762).
    const role = seat <= input.maxSeats ? "player" : "viewer";
    const token = randomBytes(16).toString("hex");

    await tx.insert(peerTokens).values({
      sessionId: input.sessionId,
      token,
      seat,
      role,
      clientId: input.clientId,
    });

    return { token, seat, role, reused: false };
  });
}
