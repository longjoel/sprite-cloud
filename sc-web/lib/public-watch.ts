import { and, desc, inArray, isNotNull, like } from "drizzle-orm";
import { db } from "@/lib/db";
import { sessions } from "@/lib/db/schema";

const ACTIVE_STATUSES = ["spawning", "ready", "connected", "playing"] as const;
const PUBLIC_ROOM_PREFIX = "public_";

type ActiveStatus = (typeof ACTIVE_STATUSES)[number];

export interface PublicWatchPreview {
  gameName: string;
  platform: string;
  href: string;
  status: ActiveStatus;
}

async function latestExplicitlySharedSession() {
  const [row] = await db
    .select({
      id: sessions.id,
      gameId: sessions.gameId,
      serverId: sessions.serverId,
      roomToken: sessions.roomToken,
      status: sessions.status,
    })
    .from(sessions)
    .where(and(
      isNotNull(sessions.serverId),
      isNotNull(sessions.roomToken),
      like(sessions.roomToken, `${PUBLIC_ROOM_PREFIX}%`),
      inArray(sessions.status, [...ACTIVE_STATUSES]),
    ))
    .orderBy(desc(sessions.createdAt))
    .limit(1);
  return row ?? null;
}

export async function resolvePublicWatchSession() {
  const session = await latestExplicitlySharedSession();
  if (!session?.serverId || !session.roomToken) return null;
  return { roomToken: session.roomToken, gameId: session.gameId, serverId: session.serverId };
}

export async function getPublicWatchPreview(): Promise<PublicWatchPreview | null> {
  const session = await latestExplicitlySharedSession();
  if (!session) return null;
  return {
    gameName: "Live session",
    platform: "Remote play",
    href: "/watch",
    status: session.status as ActiveStatus,
  };
}
