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

  // Find all servers the user is a member of
  let serverIds: string[] = [];
  if (session?.user?.id) {
    const memberships = await db
      .select({ serverId: servers.id })
      .from(serverMembers)
      .innerJoin(servers, eq(serverMembers.serverId, servers.id))
      .where(eq(serverMembers.userId, session.user.id));
    serverIds = memberships.map((m) => m.serverId);
  }

  return (
    <LibraryClient
      games={games}
      serverIds={serverIds}
      session={session ? { user: session.user } : null}
    />
  );
}
