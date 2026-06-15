import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { serverMembers, servers } from "@/lib/db/schema";
import { listGames } from "@/lib/games";
import { eq } from "drizzle-orm";

// ── Server component — runs at request time ─────────────────────────

export default async function Home() {
  const session = await auth();
  const games = await listGames();

  // Find the user's server (first server they're a member of)
  let serverId: string | null = null;
  if (session?.user?.id) {
    const [membership] = await db
      .select({ serverId: servers.id })
      .from(serverMembers)
      .innerJoin(servers, eq(serverMembers.serverId, servers.id))
      .where(eq(serverMembers.userId, session.user.id))
      .limit(1);
    serverId = membership?.serverId ?? null;
  }

  return (
    <main style={styles.main}>
      <div style={styles.topBar}>
        <h1 style={styles.title}>Games Vault</h1>
        {session ? (
          <div style={styles.userInfo}>
            <span style={styles.userName}>{session.user?.name || session.user?.email || "User"}</span>
            <a style={styles.link} href="/settings">
              Settings
            </a>
            <a style={styles.link} href="/api/auth/signout">
              Sign out
            </a>
          </div>
        ) : (
          <a style={styles.link} href="/api/auth/signin">
            Sign in
          </a>
        )}
      </div>

      {!session && (
        <div style={styles.banner}>
          Sign in to play games on your server.
        </div>
      )}

      <section style={styles.section}>
        <h2 style={styles.h2}>Library</h2>

        {games.length === 0 ? (
          <p style={styles.empty}>No games found.</p>
        ) : (
          <div style={styles.grid}>
            {games.map((game) => (
              <div key={game.id} style={styles.card}>
                <div style={styles.cardTitle}>{game.name}</div>
                <div style={styles.cardMeta}>{game.platform} · {game.maxPlayers}p</div>
                {session && serverId ? (
                  <a
                    style={styles.playBtn}
                    href={`/play/${game.id}?server_id=${serverId}`}
                  >
                    Play
                  </a>
                ) : (
                  <span style={styles.playBtnDisabled}>
                    {!session ? "Sign in" : "No server"}
                  </span>
                )}
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Dev shortcut — always visible if logged in */}
      {session && (
        <section style={styles.section}>
          <h2 style={styles.h2}>Tools</h2>
          <a style={styles.link} href="/dev">Dev Dashboard</a>
        </section>
      )}
    </main>
  );
}

// ── Styles ──────────────────────────────────────────────────────────

const styles: Record<string, React.CSSProperties> = {
  main: {
    padding: "2rem",
    fontFamily: "monospace",
    background: "#111",
    color: "#ccc",
    minHeight: "100vh",
  },
  topBar: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: "2rem",
  },
  title: { margin: 0, fontSize: "1.5rem", color: "#fff" },
  userInfo: { display: "flex", alignItems: "center", gap: 16 },
  userName: { fontSize: 13, color: "#888" },
  link: { color: "#6af", textDecoration: "none", fontSize: 13 },
  banner: {
    padding: "12px 16px",
    background: "rgba(100,160,255,0.1)",
    border: "1px solid rgba(100,160,255,0.3)",
    borderRadius: 4,
    marginBottom: "2rem",
    fontSize: 13,
    color: "#6af",
  },
  section: { marginBottom: "2rem" },
  h2: { margin: "0 0 1rem", fontSize: "1rem", color: "#aaa" },
  empty: { fontSize: 13, color: "#666", fontStyle: "italic" },
  grid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))",
    gap: 12,
  },
  card: {
    border: "1px solid #333",
    padding: "16px",
    borderRadius: 4,
    background: "#1a1a1a",
  },
  cardTitle: { fontSize: 16, color: "#fff", marginBottom: 4 },
  cardMeta: { fontSize: 11, color: "#666", marginBottom: 12 },
  playBtn: {
    display: "inline-block",
    padding: "6px 18px",
    background: "#2a2",
    color: "#000",
    textDecoration: "none",
    borderRadius: 3,
    fontSize: 13,
    fontFamily: "monospace",
    fontWeight: 700,
  },
  playBtnDisabled: {
    display: "inline-block",
    padding: "6px 18px",
    background: "#333",
    color: "#666",
    borderRadius: 3,
    fontSize: 13,
    fontFamily: "monospace",
  },
};
