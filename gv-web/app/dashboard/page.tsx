import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import {
  serverMembers,
  servers,
  serverRomRoots,
  commands,
  sessions,
  games,
} from "@/lib/db/schema";
import { eq, desc, count, and, sql } from "drizzle-orm";
import { redirect } from "next/navigation";

interface ComponentVersion {
  package_version: string;
  git_sha?: string;
  artifact_sha256?: string;
  built_at_utc?: string;
  released_at_utc?: string;
  binary_path?: string;
}

interface VersionMetadata {
  server?: ComponentVersion;
  worker?: ComponentVersion;
  runner?: ComponentVersion;
}

interface ServerMetadata {
  version?: string;
  versions?: VersionMetadata;
  rom_roots?: string[];
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readComponentVersion(value: unknown): ComponentVersion | null {
  const obj = asObject(value);
  if (!obj || typeof obj.package_version !== "string") return null;
  return {
    package_version: obj.package_version,
    git_sha: typeof obj.git_sha === "string" ? obj.git_sha : undefined,
    artifact_sha256:
      typeof obj.artifact_sha256 === "string" ? obj.artifact_sha256 : undefined,
    built_at_utc: typeof obj.built_at_utc === "string" ? obj.built_at_utc : undefined,
    released_at_utc:
      typeof obj.released_at_utc === "string" ? obj.released_at_utc : undefined,
    binary_path: typeof obj.binary_path === "string" ? obj.binary_path : undefined,
  };
}

function readServerMetadata(value: unknown): ServerMetadata {
  const obj = asObject(value);
  if (!obj) return {};
  const versions = asObject(obj.versions);
  return {
    version: typeof obj.version === "string" ? obj.version : undefined,
    rom_roots: Array.isArray(obj.rom_roots)
      ? obj.rom_roots.filter((x): x is string => typeof x === "string")
      : undefined,
    versions: versions
      ? {
          server: readComponentVersion(versions.server) ?? undefined,
          worker: readComponentVersion(versions.worker) ?? undefined,
          runner: readComponentVersion(versions.runner) ?? undefined,
        }
      : undefined,
  };
}

function shortSha(sha?: string): string {
  return sha ? sha.slice(0, 7) : "—";
}

function formatTimestamp(ts?: string): string {
  if (!ts) return "—";
  return ts.replace("T", " ").replace("Z", " UTC");
}

function webVersion(): ComponentVersion {
  return {
    package_version: process.env.GV_WEB_VERSION || "unknown",
    git_sha: process.env.GV_WEB_GIT_SHA || undefined,
    released_at_utc: process.env.GV_WEB_RELEASED_AT_UTC || undefined,
  };
}

// ── Dashboard — admin-only operational view ─────────────────────────

export default async function DashboardPage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/api/auth/signin");

  // Find servers the user is an admin of
  const adminServers = await db
    .select({
      id: servers.id,
      name: servers.name,
      lastSeenAt: servers.lastSeenAt,
      metadata: servers.metadata,
    })
    .from(serverMembers)
    .innerJoin(servers, eq(serverMembers.serverId, servers.id))
    .where(
      and(
        eq(serverMembers.userId, session.user.id),
        eq(serverMembers.role, "admin"),
      ),
    );

  if (adminServers.length === 0) {
    return (
      <main style={S.main}>
        <h1 style={S.h1}>Dashboard</h1>
        <div style={S.card}>
          <p style={S.empty}>
            No servers with admin access. Pair a gv-server and become its
            admin to see the dashboard.
          </p>
        </div>
      </main>
    );
  }

  const serverIds = adminServers.map((s) => s.id);

  // ── ROM roots ────────────────────────────────────────────────────
  const romRoots = await db
    .select({ path: serverRomRoots.path, serverId: serverRomRoots.serverId })
    .from(serverRomRoots)
    .where(
      sql`${serverRomRoots.serverId} = ANY(ARRAY[${sql.join(
        serverIds.map((id) => sql`${id}::uuid`),
        sql`, `,
      )}]::uuid[])`,
    );

  // ── Commands — last 20 ───────────────────────────────────────────
  const recentCommands = await db
    .select({
      id: commands.id,
      type: commands.type,
      status: commands.status,
      attempts: commands.attempts,
      lastError: commands.lastError,
      createdAt: commands.createdAt,
      completedAt: commands.completedAt,
      serverId: commands.serverId,
    })
    .from(commands)
    .where(
      sql`${commands.serverId} = ANY(ARRAY[${sql.join(
        serverIds.map((id) => sql`${id}::uuid`),
        sql`, `,
      )}]::uuid[])`,
    )
    .orderBy(desc(commands.createdAt))
    .limit(20);

  // ── Sessions — counts by status ──────────────────────────────────
  const sessionCounts = await db
    .select({
      status: sessions.status,
      count: count(sessions.id),
    })
    .from(sessions)
    .where(
      sql`${sessions.serverId} = ANY(ARRAY[${sql.join(
        serverIds.map((id) => sql`${id}::uuid`),
        sql`, `,
      )}]::uuid[])`,
    )
    .groupBy(sessions.status);

  // Active sessions (ready/connected/playing)
  const activeSessions = await db
    .select({
      id: sessions.id,
      gameId: sessions.gameId,
      workerUrl: sessions.workerUrl,
      status: sessions.status,
      createdAt: sessions.createdAt,
    })
    .from(sessions)
    .where(
      and(
        sql`${sessions.serverId} = ANY(ARRAY[${sql.join(
          serverIds.map((id) => sql`${id}::uuid`),
          sql`, `,
        )}]::uuid[])`,
        sql`${sessions.status} IN ('ready','connected','playing','spawning')`,
      ),
    )
    .orderBy(desc(sessions.createdAt))
    .limit(10);

  // Stuck spawning — >60s old
  const stuckSpawning = activeSessions.filter(
    (s) =>
      s.status === "spawning" &&
      Date.now() - new Date(s.createdAt!).getTime() > 60_000,
  );

  // ── Library stats — games by platform ────────────────────────────
  const platformCounts = await db
    .select({
      platform: games.platform,
      count: count(games.id),
    })
    .from(games)
    .groupBy(games.platform)
    .orderBy(desc(count(games.id)));

  const totalGames = platformCounts.reduce((sum, p) => sum + p.count, 0);

  // ── Recent errors — failed commands ──────────────────────────────
  const recentErrors = recentCommands.filter(
    (c) => c.status === "failed" && c.lastError,
  );

  // Helpers
  const now = Date.now();
  const serverOnline =
    adminServers[0]?.lastSeenAt
      ? now - new Date(adminServers[0].lastSeenAt).getTime() < 120_000
      : false;
  const lastSeenSecs = adminServers[0]?.lastSeenAt
    ? Math.round((now - new Date(adminServers[0].lastSeenAt).getTime()) / 1000)
    : null;

  const serverMetadata = adminServers.map((srv) => ({
    id: srv.id,
    name: srv.name || srv.id.slice(0, 8),
    metadata: readServerMetadata(srv.metadata),
  }));
  const liveWebVersion = webVersion();

  const sessionMap: Record<string, number> = {};
  for (const row of sessionCounts) {
    sessionMap[row.status] = row.count;
  }

  return (
    <main style={S.main}>
      <div style={S.header}>
        <h1 style={S.h1}>Dashboard</h1>
        <span style={S.refreshHint}>Refresh to update</span>
      </div>

      {/* ── Server status ─────────────────────────────────────────── */}
      <section style={S.section}>
        <h2 style={S.h2}>Server</h2>
        <div style={S.card}>
          <div style={S.row}>
            <span style={S.label}>Status</span>
            <span
              style={{
                ...S.badge,
                background: serverOnline
                  ? "var(--color-successBg)"
                  : "var(--color-errorBg)",
                color: serverOnline
                  ? "var(--color-success)"
                  : "var(--color-error)",
              }}
            >
              {serverOnline ? "online" : "offline"}
            </span>
          </div>
          {lastSeenSecs !== null && (
            <div style={S.row}>
              <span style={S.label}>Last poll</span>
              <span style={S.value}>
                {lastSeenSecs < 10
                  ? "just now"
                  : `${lastSeenSecs}s ago`}
              </span>
            </div>
          )}
          {adminServers.map((srv) => (
            <div key={srv.id} style={S.row}>
              <span style={S.label}>Server ID</span>
              <code style={S.code}>{srv.id.slice(0, 13)}…</code>
            </div>
          ))}
          <div style={S.row}>
            <span style={S.label}>ROM roots</span>
            <span style={S.value}>
              {romRoots.length > 0
                ? romRoots.map((r) => r.path).join(", ")
                : "none reported"}
            </span>
          </div>
          <div style={S.row}>
            <span style={S.label}>Active workers</span>
            <span style={S.value}>
              {
                activeSessions.filter((s) =>
                  ["ready", "connected", "playing"].includes(s.status),
                ).length
              }{" "}
              running
              {stuckSpawning.length > 0 && (
                <span style={S.warn}>
                  {" "}
                  +{stuckSpawning.length} stuck spawning
                </span>
              )}
            </span>
          </div>
        </div>
      </section>


      {/* ── Live versions ──────────────────────────────────────────── */}
      <section style={S.section}>
        <h2 style={S.h2}>Live versions</h2>
        <div style={S.card}>
          <div style={S.tableWrap}>
            <table style={S.table}>
              <thead>
                <tr>
                  <th style={S.th}>Scope</th>
                  <th style={S.th}>Component</th>
                  <th style={S.th}>Package</th>
                  <th style={S.th}>Commit</th>
                  <th style={S.th}>Built / released</th>
                  <th style={S.th}>Path</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td style={S.td}>web</td>
                  <td style={S.td}>gv-web</td>
                  <td style={S.td}>
                    <code style={S.code}>{liveWebVersion.package_version}</code>
                  </td>
                  <td style={S.td}>
                    <code style={S.code}>{shortSha(liveWebVersion.git_sha)}</code>
                  </td>
                  <td style={S.td}>{formatTimestamp(liveWebVersion.released_at_utc)}</td>
                  <td style={S.td}>
                    <span style={S.muted}>container env</span>
                  </td>
                </tr>
                {serverMetadata.flatMap((srv) => {
                  const versions = srv.metadata.versions;
                  if (!versions?.server && !versions?.worker && !versions?.runner) {
                    return [
                      <tr key={`${srv.id}-missing`}>
                        <td style={S.td}>{srv.name}</td>
                        <td style={S.td} colSpan={5}>
                          <span style={S.muted}>No component versions reported yet.</span>
                        </td>
                      </tr>,
                    ];
                  }

                  return ([
                    ["server", versions?.server],
                    ["worker", versions?.worker],
                    ["runner", versions?.runner],
                  ] as const)
                    .filter(([, version]) => Boolean(version))
                    .map(([component, version]) => (
                      <tr key={`${srv.id}-${component}`}>
                        <td style={S.td}>{srv.name}</td>
                        <td style={S.td}>{component}</td>
                        <td style={S.td}>
                          <code style={S.code}>{version?.package_version ?? "—"}</code>
                        </td>
                        <td style={S.td}>
                          <code style={S.code}>{shortSha(version?.git_sha)}</code>
                        </td>
                        <td style={S.td}>
                          {formatTimestamp(version?.built_at_utc || version?.released_at_utc)}
                        </td>
                        <td style={S.td}>
                          {version?.binary_path ? (
                            <code style={S.code}>{version.binary_path}</code>
                          ) : (
                            <span style={S.muted}>—</span>
                          )}
                        </td>
                      </tr>
                    ));
                })}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      {/* ── Sessions ──────────────────────────────────────────────── */}
      <section style={S.section}>
        <h2 style={S.h2}>Sessions</h2>
        <div style={S.card}>
          <div style={S.stats}>
            {(["spawning", "ready", "connected", "playing", "ended"] as const).map(
              (st) => (
                <div key={st} style={S.stat}>
                  <span style={S.statCount}>{sessionMap[st] ?? 0}</span>
                  <span style={S.statLabel}>{st}</span>
                </div>
              ),
            )}
          </div>
          {activeSessions.length > 0 && (
            <div style={S.tableWrap}>
              <table style={S.table}>
                <thead>
                  <tr>
                    <th style={S.th}>Status</th>
                    <th style={S.th}>Game</th>
                    <th style={S.th}>Worker</th>
                    <th style={S.th}>Age</th>
                  </tr>
                </thead>
                <tbody>
                  {activeSessions.map((s) => {
                    const ageSecs = s.createdAt
                      ? Math.round(
                          (now - new Date(s.createdAt).getTime()) / 1000,
                        )
                      : null;
                    return (
                      <tr key={s.id}>
                        <td style={S.td}>
                          <span
                            style={{
                              ...S.statusDot,
                              background:
                                s.status === "spawning"
                                  ? "var(--color-warning)"
                                  : s.status === "ready"
                                    ? "var(--color-cyan)"
                                    : s.status === "connected"
                                      ? "var(--color-lime)"
                                      : "var(--color-success)",
                            }}
                          />{" "}
                          {s.status}
                        </td>
                        <td style={S.td}>
                          <code style={S.code}>
                            {s.gameId.slice(0, 13)}…
                          </code>
                        </td>
                        <td style={S.td}>
                          {s.workerUrl ? (
                            <code style={S.code}>{s.workerUrl}</code>
                          ) : (
                            <span style={S.muted}>—</span>
                          )}
                        </td>
                        <td style={S.td}>
                          {ageSecs !== null
                            ? ageSecs < 60
                              ? `${ageSecs}s`
                              : `${Math.round(ageSecs / 60)}m`
                            : "—"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </section>

      {/* ── Commands ──────────────────────────────────────────────── */}
      <section style={S.section}>
        <h2 style={S.h2}>
          Commands
          {recentErrors.length > 0 && (
            <span style={S.warn}> — {recentErrors.length} recent errors</span>
          )}
        </h2>
        <div style={S.card}>
          <div style={S.tableWrap}>
            <table style={S.table}>
              <thead>
                <tr>
                  <th style={S.th}>Type</th>
                  <th style={S.th}>Status</th>
                  <th style={S.th}>Attempts</th>
                  <th style={S.th}>Created</th>
                  <th style={S.th}>Error</th>
                </tr>
              </thead>
              <tbody>
                {recentCommands.map((cmd) => {
                  const ageSecs = cmd.createdAt
                    ? Math.round(
                        (now - new Date(cmd.createdAt).getTime()) / 1000,
                      )
                    : null;
                  return (
                    <tr key={cmd.id}>
                      <td style={S.td}>
                        <code style={S.code}>{cmd.type}</code>
                      </td>
                      <td style={S.td}>
                        <span
                          style={{
                            ...S.badge,
                            background:
                              cmd.status === "completed"
                                ? "var(--color-successBg)"
                                : cmd.status === "failed"
                                  ? "var(--color-errorBg)"
                                  : cmd.status === "leased"
                                    ? "var(--color-infoBg)"
                                    : "var(--color-warningBg)",
                            color:
                              cmd.status === "completed"
                                ? "var(--color-success)"
                                : cmd.status === "failed"
                                  ? "var(--color-error)"
                                  : cmd.status === "leased"
                                    ? "var(--color-cyan)"
                                    : "var(--color-warning)",
                          }}
                        >
                          {cmd.status}
                        </span>
                      </td>
                      <td style={S.td}>{cmd.attempts}</td>
                      <td style={S.td}>
                        {ageSecs !== null
                          ? ageSecs < 120
                            ? `${ageSecs}s ago`
                            : `${Math.round(ageSecs / 60)}m ago`
                          : "—"}
                      </td>
                      <td style={S.td}>
                        {cmd.lastError ? (
                          <span style={S.errorText}>
                            {cmd.lastError.slice(0, 80)}
                            {cmd.lastError.length > 80 ? "…" : ""}
                          </span>
                        ) : (
                          <span style={S.muted}>—</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      {/* ── Library ───────────────────────────────────────────────── */}
      <section style={S.section}>
        <h2 style={S.h2}>Library</h2>
        <div style={S.card}>
          <div style={S.row}>
            <span style={S.label}>Total games</span>
            <span style={S.value}>{totalGames}</span>
          </div>
          {platformCounts.length > 0 && (
            <div style={{ ...S.stats, marginTop: "var(--space-6)" }}>
              {platformCounts.map((p) => (
                <div key={p.platform} style={S.stat}>
                  <span style={S.statCount}>{p.count}</span>
                  <span style={S.statLabel}>{p.platform}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </section>
    </main>
  );
}

// ── Styles (Humidor design tokens) ──────────────────────────────────

const S: Record<string, React.CSSProperties> = {
  main: {
    maxWidth: 960,
    margin: "0 auto",
    padding: "var(--space-8)",
    fontFamily: "var(--font-mono)",
    color: "var(--color-cream)",
    background: "var(--color-mahogany)",
    minHeight: "100vh",
  },
  header: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "baseline",
    marginBottom: "var(--space-8)",
  },
  h1: {
    fontSize: "var(--font-size-h1)",
    fontWeight: 600,
    color: "var(--color-cream)",
    margin: 0,
  },
  h2: {
    fontSize: "var(--font-size-h2)",
    fontWeight: 500,
    color: "var(--color-brass)",
    textTransform: "uppercase" as const,
    letterSpacing: "0.05em",
    marginBottom: "var(--space-5)",
  },
  refreshHint: {
    fontSize: "var(--font-size-xs)",
    color: "var(--color-muted)",
  },
  section: {
    marginBottom: "var(--space-8)",
  },
  card: {
    background: "var(--color-teak)",
    border: "1px solid var(--color-bamboo)",
    borderRadius: "var(--radius-md)",
    padding: "var(--space-6)",
  },
  row: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: "var(--space-2) 0",
    borderBottom: "1px solid var(--color-walnut)",
    fontSize: "var(--font-size-sm)",
  },
  label: {
    color: "var(--color-muted)",
    fontSize: "var(--font-size-sm)",
  },
  value: {
    color: "var(--color-cream)",
    fontSize: "var(--font-size-sm)",
    fontFamily: "var(--font-mono)",
  },
  code: {
    fontSize: "var(--font-size-xs)",
    fontFamily: "var(--font-mono)",
    color: "var(--color-cyan)",
    background: "var(--color-mahogany)",
    padding: "1px 4px",
    borderRadius: "var(--radius-sm)",
  },
  badge: {
    fontSize: "var(--font-size-xs)",
    fontFamily: "var(--font-mono)",
    fontWeight: 600,
    padding: "1px 6px",
    borderRadius: "var(--radius-pill)",
    textTransform: "uppercase" as const,
  },
  stats: {
    display: "flex",
    gap: "var(--space-7)",
    flexWrap: "wrap" as const,
  },
  stat: {
    display: "flex",
    flexDirection: "column" as const,
    alignItems: "center",
    gap: "var(--space-1)",
  },
  statCount: {
    fontSize: "var(--font-size-h3)",
    fontWeight: 700,
    color: "var(--color-cream)",
    fontFamily: "var(--font-mono)",
  },
  statLabel: {
    fontSize: "var(--font-size-xs)",
    color: "var(--color-muted)",
    textTransform: "uppercase" as const,
    letterSpacing: "0.03em",
  },
  tableWrap: {
    overflowX: "auto" as const,
  },
  table: {
    width: "100%",
    borderCollapse: "collapse" as const,
    fontSize: "var(--font-size-sm)",
  },
  th: {
    textAlign: "left" as const,
    padding: "var(--space-2) var(--space-4)",
    color: "var(--color-muted)",
    fontWeight: 500,
    textTransform: "uppercase" as const,
    fontSize: "var(--font-size-xs)",
    letterSpacing: "0.05em",
    borderBottom: "1px solid var(--color-bamboo)",
  },
  td: {
    padding: "var(--space-2) var(--space-4)",
    borderBottom: "1px solid var(--color-walnut)",
    color: "var(--color-cream)",
  },
  statusDot: {
    display: "inline-block",
    width: 6,
    height: 6,
    borderRadius: "50%",
    marginRight: "var(--space-2)",
  },
  warn: {
    color: "var(--color-warning)",
    fontSize: "var(--font-size-sm)",
  },
  errorText: {
    color: "var(--color-error)",
    fontSize: "var(--font-size-xs)",
    fontFamily: "var(--font-mono)",
  },
  muted: {
    color: "var(--color-muted)",
    fontSize: "var(--font-size-xs)",
  },
  empty: {
    color: "var(--color-muted)",
    fontSize: "var(--font-size-sm)",
  },
};
