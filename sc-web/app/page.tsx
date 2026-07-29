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
    // Show the landing page for unauthenticated visitors
    return <LandingPage />;
  }

  // Authenticated: find all servers the user is a member of
  const memberships = await db
    .select({ serverId: servers.id, name: servers.name, metadata: servers.metadata, role: serverMembers.role })
    .from(serverMembers)
    .innerJoin(servers, eq(serverMembers.serverId, servers.id))
    .where(eq(serverMembers.userId, session.user.id));
  const serverIds = memberships.map((m) => m.serverId);
  const lanLibraries = extractLanLibraryLinks(memberships);

  // Admin servers (for ROM upload dropzone)
  const adminServers = memberships
    .filter((m) => m.role === "admin")
    .map((m) => ({
      id: m.serverId,
      name: m.name,
      status: ((m.metadata as Record<string, unknown> | null)?.status as string) ?? "unknown",
    }));

  return (
    <LibraryClient
      serverIds={serverIds}
      lanLibraries={lanLibraries}
      session={{ user: session.user }}
      isLanProxy={false}
      adminServers={adminServers}
    />
  );
}
