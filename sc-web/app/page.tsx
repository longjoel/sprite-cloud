import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { serverMembers, servers, users } from "@/lib/db/schema";
import { eq, sql } from "drizzle-orm";
import LandingPage from "@/components/LandingPage";
import LibraryClient from "@/components/LibraryClient";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { verifyBearerToken } from "@/lib/server-auth";
import { extractLanLibraryLinks } from "@/lib/lan/library-handoff";

// ── Home page — Living Cabinet wall for everyone
// Authenticated users are redirected to /library.
// Unauthenticated visitors see the wall (LandingPage).
// LAN proxy requests get LibraryClient.

export default async function Home() {
  const session = await auth();
  const requestHeaders = await headers();
  const hasLanMarker = requestHeaders.get("x-sc-server-lan") === "1";
  const lanServer = hasLanMarker
    ? await verifyBearerToken(requestHeaders.get("authorization"))
    : null;
  const isLanProxy = lanServer !== null;

  // First-run: if no users exist, show setup
  if (!session?.user?.id) {
    if (isLanProxy) {
      return <LibraryClient serverIds={[]} session={null} isLanProxy />;
    }
    const [row] = await db
      .select({ count: sql<number>`count(*)` })
      .from(users);
    if (Number(row?.count ?? 0) === 0) {
      redirect("/setup");
    }
    // Show the living cabinet wall
    return <LandingPage />;
  }

  // Authenticated — redirect to library
  if (!isLanProxy) {
    redirect("/library");
  }

  // LAN proxy — show library
  const memberships = await db
    .select({ serverId: servers.id, name: servers.name, metadata: servers.metadata, role: serverMembers.role })
    .from(serverMembers)
    .innerJoin(servers, eq(serverMembers.serverId, servers.id))
    .where(eq(serverMembers.userId, session.user.id));
  const serverIds = memberships.map((m) => m.serverId);
  const lanLibraries = extractLanLibraryLinks(memberships);

  return (
    <LibraryClient
      serverIds={serverIds}
      lanLibraries={lanLibraries}
      session={{ user: session.user }}
      isLanProxy
    />
  );
}
