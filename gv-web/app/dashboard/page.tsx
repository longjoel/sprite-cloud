import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { serverMembers, servers, serverRomRoots } from "@/lib/db/schema";
import { and, eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import AppHeader from "@/components/fluent/AppHeader";
import DashboardClient from "./DashboardClient";

// ── Dashboard — server-first admin surface ────────────────────────────

export default async function DashboardPage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/api/auth/signin");

  const adminServers = await db
    .select({
      id: servers.id,
      name: servers.name,
      lastSeenAt: servers.lastSeenAt,
    })
    .from(serverMembers)
    .innerJoin(servers, eq(serverMembers.serverId, servers.id))
    .where(
      and(
        eq(serverMembers.userId, session.user.id),
        eq(serverMembers.role, "admin"),
      ),
    );

  const romRootsByServer: Record<string, string[]> = {};
  for (const srv of adminServers) {
    const roots = await db
      .select({ path: serverRomRoots.path })
      .from(serverRomRoots)
      .where(eq(serverRomRoots.serverId, srv.id));
    romRootsByServer[srv.id] = roots.map((r) => r.path);
  }

  return (
    <main style={S.main}>
      <AppHeader
        userName={session.user?.name || session.user?.email || undefined}
        links={[
          { label: "← Library", href: "/" },
          { label: "Sign out", href: "/api/auth/signout" },
        ]}
      />

      <section style={S.hero}>
        <p style={S.kicker}>Dashboard</p>
        <h1 style={S.title}>Your servers</h1>
        <p style={S.subtitle}>
          Pair, rename, inspect, and remove the gv-server instances you
          administer. This page is intentionally server-first.
        </p>
      </section>

      {adminServers.length === 0 ? (
        <section style={S.section}>
          <div style={S.card}>
            <p style={S.empty}>
              No servers with admin access yet. Pair a gv-server and become its
              admin to manage it here.
            </p>
          </div>
        </section>
      ) : (
        <DashboardClient
          memberships={adminServers.map((srv) => ({
            id: srv.id,
            name: srv.name || srv.id.slice(0, 8),
            lastSeenAt: srv.lastSeenAt?.toISOString() ?? null,
            role: "admin",
            romRoots: romRootsByServer[srv.id] ?? [],
          }))}
        />
      )}
    </main>
  );
}

const S: Record<string, React.CSSProperties> = {
  main: {
    padding: "0",
    fontFamily: "var(--font-mono)",
    background: "var(--color-sky-deep)",
    color: "var(--color-cloud)",
    minHeight: "100vh",
  },
  hero: {
    padding: "24px 24px 0",
    marginBottom: "var(--space-6)",
  },
  kicker: {
    margin: 0,
    color: "var(--color-cloud-dim)",
    fontSize: "var(--font-size-sm)",
    textTransform: "uppercase",
    letterSpacing: "0.08em",
  },
  title: {
    margin: "8px 0 0",
    fontSize: "var(--font-size-h2)",
    color: "var(--color-accent)",
    fontWeight: 700,
  },
  subtitle: {
    margin: "12px 0 0",
    maxWidth: 720,
    color: "var(--color-cloud-dim)",
    fontSize: "var(--font-size-base)",
    lineHeight: 1.6,
  },
  section: {
    padding: "0 24px",
  },
  card: {
    border: "1px solid var(--color-sky-high)",
    background: "var(--color-sky-mid)",
    padding: "var(--space-6)",
  },
  empty: {
    margin: 0,
    color: "var(--color-cloud-dim)",
    fontSize: "var(--font-size-base)",
  },
};
