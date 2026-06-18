import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { serverMembers, servers } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { redirect } from "next/navigation";

export default async function SettingsPage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/api/auth/signin");

  const memberships = await db
    .select({
      id: servers.id,
      name: servers.name,
      lastSeenAt: servers.lastSeenAt,
    })
    .from(serverMembers)
    .innerJoin(servers, eq(serverMembers.serverId, servers.id))
    .where(eq(serverMembers.userId, session.user.id))
    .orderBy(servers.name);

  return (
    <main style={S.main}>
      <h1 style={S.h1}>Settings</h1>

      <section style={S.section}>
        <h2 style={S.h2}>Servers</h2>
        {memberships.length === 0 ? (
          <p style={S.empty}>No servers. Pair a gv-server first.</p>
        ) : (
          <table style={S.table}>
            <thead>
              <tr>
                <th style={S.th}>Name</th>
                <th style={S.th}>Last seen</th>
                <th style={S.th} />
              </tr>
            </thead>
            <tbody>
              {memberships.map((s) => (
                <tr key={s.id}>
                  <td style={S.td}>{s.name || s.id.slice(0, 8)}</td>
                  <td style={S.td}>
                    {s.lastSeenAt
                      ? new Date(s.lastSeenAt).toLocaleString()
                      : "never"}
                  </td>
                  <td style={S.td}>
                    <a href={`/settings/${s.id}`} style={S.link}>
                      Manage
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <p>
        <a href="/" style={S.link}>← Library</a>
      </p>
    </main>
  );
}

const S: Record<string, React.CSSProperties> = {
  main: {
    padding: "var(--space-8)",
    fontFamily: "var(--font-mono)",
    background: "var(--color-mahogany)",
    color: "var(--color-cream)",
    minHeight: "100vh",
  },
  h1: {
    margin: "0 0 var(--space-8)",
    fontSize: "var(--font-size-h1)",
    color: "var(--color-brass)",
    fontFamily: "var(--font-mono)",
  },
  h2: {
    margin: "0 0 var(--space-6)",
    fontSize: "var(--font-size-h2)",
    color: "var(--color-muted)",
    fontFamily: "var(--font-mono)",
  },
  section: { marginBottom: "var(--space-8)" },
  empty: {
    fontSize: "var(--font-size-base)",
    color: "var(--color-muted)",
    fontStyle: "italic",
  },
  table: { width: "100%", borderCollapse: "collapse" as const },
  th: {
    textAlign: "left" as const,
    padding: "var(--space-4) var(--space-5)",
    borderBottom: "1px solid var(--color-bamboo)",
    fontSize: "var(--font-size-sm)",
    color: "var(--color-muted)",
    fontFamily: "var(--font-mono)",
  },
  td: {
    padding: "var(--space-4) var(--space-5)",
    borderBottom: "1px solid var(--color-teak)",
    fontSize: "var(--font-size-base)",
  },
  link: {
    color: "var(--color-info)",
    textDecoration: "none",
    fontSize: "var(--font-size-base)",
    fontFamily: "var(--font-mono)",
  },
};
