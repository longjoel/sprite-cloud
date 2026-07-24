import { randomBytes } from "crypto";
import { and, desc, eq, inArray, isNotNull } from "drizzle-orm";
import { db } from "@/lib/db";
import { sessions } from "@/lib/db/schema";

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

    })
    .from(sessions)

    .where(
      and(
        isNotNull(sessions.serverId),
        isNotNull(sessions.hostToken),

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

export async function resolvePublicWatchSession() {
  const session = await latestActiveSession();
  if (!session?.serverId || !session.hostToken) return null;
  const roomToken = await ensureRoomToken(session.id, session.roomToken);
  return { roomToken, gameId: session.gameId, serverId: session.serverId };
}

export async function getPublicWatchPreview(): Promise<PublicWatchPreview | null> {
  const session = await latestActiveSession();
  if (!session) return null;
  return {
    gameName: "Live session",
    platform: "Remote play",
    href: "/watch",
    status: session.status as ActiveStatus,
  };
}
