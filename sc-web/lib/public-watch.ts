import { randomBytes } from "crypto";
import { and, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { games, sessions } from "@/lib/db/schema";

const ACTIVE_STATUSES = ["spawning", "ready", "connected", "playing"] as const;

type ActiveStatus = (typeof ACTIVE_STATUSES)[number];

export interface PublicWatchPreview {
  gameName: string;
  platform: string;
  href: string;
  status: ActiveStatus;
}

async function latestActiveSession() {
  const [row] = await db
    .select({
      id: sessions.id,
      gameId: sessions.gameId,
      serverId: sessions.serverId,
      hostToken: sessions.hostToken,
      roomToken: sessions.roomToken,
      status: sessions.status,
      gameName: games.name,
      platform: games.platform,
    })
    .from(sessions)
    .innerJoin(games, sql`${games.id} = ${sessions.gameId}::uuid`)
    .where(
      and(
        isNotNull(sessions.serverId),
        isNotNull(sessions.hostToken),
        sql`${sessions.gameId} ~* '^[0-9a-f-]{36}$'`,
        inArray(sessions.status, [...ACTIVE_STATUSES]),
      ),
    )
    .orderBy(desc(sessions.createdAt))
    .limit(1);

  return row ?? null;
}

async function ensureRoomToken(sessionId: string, currentRoomToken: string | null) {
  if (currentRoomToken) return currentRoomToken;
  const roomToken = randomBytes(16).toString("hex");
  await db.update(sessions).set({ roomToken }).where(eq(sessions.id, sessionId));
  return roomToken;
}

export async function resolvePublicWatchPath(): Promise<string | null> {
  const session = await latestActiveSession();
  if (!session?.serverId || !session.hostToken) return null;
  const roomToken = await ensureRoomToken(session.id, session.roomToken);
  return `/r/${roomToken}?game_id=${encodeURIComponent(session.gameId)}&server_id=${encodeURIComponent(session.serverId)}`;
}

export async function getPublicWatchPreview(): Promise<PublicWatchPreview | null> {
  const session = await latestActiveSession();
  if (!session) return null;
  return {
    gameName: session.gameName,
    platform: session.platform,
    href: "/watch",
    status: session.status as ActiveStatus,
  };
}
