import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { serverMembers, servers, users } from "@/lib/db/schema";
import { eq, sql } from "drizzle-orm";
import LandingPage from "@/components/LandingPage";
import LibraryClient from "@/components/LibraryClient";

// ── Server component — landing page or library ────────────────────────

export default async function Home() {
  const session = await auth();

  // First-run: if no users exist, show setup
  if (!session) {
    const [row] = await db
      .select({ count: sql<number>`count(*)` })
      .from(users);
    if (Number(row?.count ?? 0) === 0) {
      // No users yet — let /setup handle itself via its own redirect
    }
    // Show the landing page for unauthenticated visitors
    return <LandingPage />;
  }

  // Authenticated: find all servers the user is a member of
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
      serverIds={serverIds}
      session={{ user: session.user }}
    />
  );
}
