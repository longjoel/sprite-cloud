import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { serverMembers, servers } from "@/lib/db/schema";
import { listGames } from "@/lib/games";
import { eq } from "drizzle-orm";
import LibraryClient from "@/components/LibraryClient";

// ── Server component — fetches data, passes to client ──────────────

export default async function Home() {
  const session = await auth();
  const games = await listGames();

  // Find the user's server (first server they're a member of)
  let serverId: string | null = null;
  if (session?.user?.id) {
    const [membership] = await db
      .select({ serverId: servers.id })
      .from(serverMembers)
      .innerJoin(servers, eq(serverMembers.serverId, servers.id))
      .where(eq(serverMembers.userId, session.user.id))
      .limit(1);
    serverId = membership?.serverId ?? null;
  }

  return (
    <LibraryClient
      games={games}
      serverId={serverId}
      session={session ? { user: session.user } : null}
    />
  );
}
