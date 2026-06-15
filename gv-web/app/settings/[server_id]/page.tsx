import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { serverMembers, servers, serverRomRoots } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { redirect } from "next/navigation";
import ServerManager from "./client";

export default async function ServerSettingsPage({
  params,
}: {
  params: Promise<{ server_id: string }>;
}) {
  const { server_id } = await params;
  const session = await auth();
  if (!session?.user?.id) redirect("/api/auth/signin");

  // Verify membership
  const [member] = await db
    .select({ name: servers.name })
    .from(serverMembers)
    .innerJoin(servers, eq(serverMembers.serverId, servers.id))
    .where(
      and(
        eq(serverMembers.serverId, server_id),
        eq(serverMembers.userId, session.user.id),
      ),
    )
    .limit(1);

  if (!member) {
    redirect("/settings");
  }

  // Get ROM roots
  const roots = await db
    .select({ path: serverRomRoots.path })
    .from(serverRomRoots)
    .where(eq(serverRomRoots.serverId, server_id));

  return (
    <ServerManager
      serverId={server_id}
      serverName={member.name}
      romRoots={roots.map((r) => r.path)}
    />
  );
}
