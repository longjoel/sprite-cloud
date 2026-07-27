import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { serverMembers, servers, users } from "@/lib/db/schema";
import { eq, sql } from "drizzle-orm";
import LandingPage from "@/components/LandingPage";
import LibraryClient from "@/components/LibraryClient";
import { headers } from "next/headers";
import { verifyBearerToken } from "@/lib/server-auth";
import { extractLanLibraryLinks } from "@/lib/lan/library-handoff";

// ── Server component — landing page or library ────────────────────────

export default async function Home() {
  const session = await auth();
  const requestHeaders = await headers();
  const hasLanMarker = requestHeaders.get("x-sc-server-lan") === "1";
  const lanServer = hasLanMarker
    ? await verifyBearerToken(requestHeaders.get("authorization"))
    : null;
  const isLanProxy = lanServer !== null;

  // First-run: if no users exist, show setup
  if (!session) {
    if (isLanProxy) {
      return <LibraryClient serverIds={[]} session={null} isLanProxy />;
    }
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
  let lanLibraries = [] as ReturnType<typeof extractLanLibraryLinks>;
  if (session?.user?.id) {
    const memberships = await db
      .select({ serverId: servers.id, name: servers.name, metadata: servers.metadata })
      .from(serverMembers)
      .innerJoin(servers, eq(serverMembers.serverId, servers.id))
      .where(eq(serverMembers.userId, session.user.id));
    serverIds = memberships.map((m) => m.serverId);
    lanLibraries = extractLanLibraryLinks(memberships);
  }

  return (
    <LibraryClient
      serverIds={serverIds}
      lanLibraries={lanLibraries}
      session={{ user: session.user }}
      isLanProxy={false}
    />
  );
}
