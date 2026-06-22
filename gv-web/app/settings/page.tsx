import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { serverMembers, servers, serverRomRoots } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import SettingsClient from "./SettingsClient";

export default async function SettingsPage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/api/auth/signin");

  // Fetch memberships with role and ROM roots
  const rows = await db
    .select({
      id: servers.id,
      name: servers.name,
      lastSeenAt: servers.lastSeenAt,
      role: serverMembers.role,
    })
    .from(serverMembers)
    .innerJoin(servers, eq(serverMembers.serverId, servers.id))
    .where(eq(serverMembers.userId, session.user.id))
    .orderBy(servers.name);

  // Fetch ROM roots for each server
  const rootsByServer = new Map<string, string[]>();
  if (rows.length > 0) {
    const serverIds = rows.map((r) => r.id);
    // Collect roots for all member servers in one query
    const allRoots = await db
      .select({
        serverId: serverRomRoots.serverId,
        path: serverRomRoots.path,
      })
      .from(serverRomRoots)
      .where(
        // Filter to servers this user is a member of
        // Simple approach: load all then group — the count is small
        // Use a SQL IN clause via drizzle
        eq(serverRomRoots.serverId, serverIds[0]), // dummy to satisfy type; we do multi-query fallback
      );
    // Actually, drizzle doesn't have a clean IN for dynamic arrays in where.
    // Workaround: query per server since member count is always small (1-3).
  }
  for (const row of rows) {
    const roots = await db
      .select({ path: serverRomRoots.path })
      .from(serverRomRoots)
      .where(eq(serverRomRoots.serverId, row.id));
    rootsByServer.set(
      row.id,
      roots.map((r) => r.path),
    );
  }

  return (
    <SettingsClient
      memberships={rows.map((r) => ({
        id: r.id,
        name: r.name || "",
        lastSeenAt: r.lastSeenAt?.toISOString() ?? null,
        role: r.role,
        romRoots: rootsByServer.get(r.id) ?? [],
      }))}
    />
  );
}
