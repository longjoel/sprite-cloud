import { db } from "@/lib/db";
import { games, gameFiles } from "@/lib/db/schema";
import { eq, inArray } from "drizzle-orm";

export interface GameEntry {
  id: string;
  name: string;
  platform: string;
  maxPlayers: number;
}

/** List games scoped to the user's server memberships.
 *  Empty serverIds → returns nothing (logged out or no servers). */
export async function listGames(serverIds: string[]): Promise<GameEntry[]> {
  if (serverIds.length === 0) return [];

  const rows = await db
    .selectDistinct({
      id: games.id,
      name: games.name,
      platform: games.platform,
      maxPlayers: games.maxPlayers,
    })
    .from(games)
    .innerJoin(gameFiles, eq(games.id, gameFiles.gameId))
    .where(inArray(gameFiles.serverId, serverIds))
    .orderBy(games.name);

  return rows as GameEntry[];
}

/** Look up a single game by id. */
export async function getGame(id: string): Promise<GameEntry | null> {
  const [row] = await db
    .select({
      id: games.id,
      name: games.name,
      platform: games.platform,
      maxPlayers: games.maxPlayers,
    })
    .from(games)
    .where(eq(games.id, id))
    .limit(1);

  return (row as GameEntry) ?? null;
}
