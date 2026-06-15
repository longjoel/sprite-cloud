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
    padding: "2rem",
    fontFamily: "monospace",
    background: "#111",
    color: "#ccc",
    minHeight: "100vh",
  },
  h1: { margin: "0 0 2rem", fontSize: "1.5rem", color: "#fff" },
  h2: { margin: "0 0 1rem", fontSize: "1rem", color: "#aaa" },
  section: { marginBottom: "2rem" },
  empty: { fontSize: 13, color: "#666", fontStyle: "italic" },
  table: { width: "100%", borderCollapse: "collapse" as const },
  th: {
    textAlign: "left" as const,
    padding: "8px 12px",
    borderBottom: "1px solid #333",
    fontSize: 12,
    color: "#888",
  },
  td: {
    padding: "8px 12px",
    borderBottom: "1px solid #222",
    fontSize: 13,
  },
  link: { color: "#6af", textDecoration: "none", fontSize: 13 },
};
