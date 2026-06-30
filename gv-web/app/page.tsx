import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { serverMembers, servers, users } from "@/lib/db/schema";
import { eq, sql } from "drizzle-orm";
import { redirect } from "next/navigation";
import LibraryClient from "@/components/LibraryClient";

// ── Server component — gate → redirect or render ──────────────────────

export default async function Home() {
  const session = await auth();

  // First-run: if no users exist, redirect to setup
  if (!session) {
    const [row] = await db
      .select({ count: sql<number>`count(*)` })
      .from(users);
    if (Number(row?.count ?? 0) === 0) {
      redirect("/setup");
    }
    redirect("/signin");
  }

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
      serverIds={serverIds}
      session={{ user: session.user }}
    />
  );
}
