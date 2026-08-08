import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { serverMembers, servers } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import LibraryClient from "@/components/LibraryClient";
import { extractLanLibraryLinks } from "@/lib/lan/library-handoff";
import { redirect } from "next/navigation";

export default async function LibraryPage() {
  const session = await auth();
  if (!session?.user?.id) {
    redirect("/signin");
  }

  const memberships = await db
    .select({
      serverId: servers.id,
      name: servers.name,
      metadata: servers.metadata,
      role: serverMembers.role,
    })
    .from(serverMembers)
    .innerJoin(servers, eq(serverMembers.serverId, servers.id))
    .where(eq(serverMembers.userId, session.user.id));
  const serverIds = memberships.map((m) => m.serverId);
  const lanLibraries = extractLanLibraryLinks(memberships);

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
