"use client";

import { useState } from "react";
import GamePlayer from "@/components/GamePlayer";

// ── Types ─────────────────────────────────────────────────────────────

interface Game {
  id: string;
  name: string;
  platform: string;
  maxPlayers: number;
}

interface PlayableHost {
  server_id: string;
  name: string;
  status: string;     // online | stale | offline
  has_game: boolean;
  route_hint: string; // local | direct | relay | unknown
}

interface LibraryClientProps {
  games: Game[];
  serverIds: string[];
  session: { user?: { name?: string | null; email?: string | null } } | null;
}

// ── Helpers ────────────────────────────────────────────────────────────

function getPreferredServer(gameId: string): string | null {
  if (typeof document === "undefined") return null;
  const match = document.cookie
    .split(";")
    .map((c) => c.trim())
    .find((c) => c.startsWith(`gv_host_${gameId}=`));
  if (!match) return null;
  return decodeURIComponent(match.split("=").slice(1).join("="));
}

function setPreferredServer(gameId: string, serverId: string) {
  if (typeof document === "undefined") return;
  document.cookie = `gv_host_${gameId}=${encodeURIComponent(serverId)}; Path=/; Max-Age=${365 * 24 * 3600}; SameSite=Lax`;
}

// ── Badge styles ───────────────────────────────────────────────────────

function statusBadge(status: string): React.CSSProperties {
  const colors: Record<string, { bg: string; fg: string }> = {
    online:  { bg: "rgba(0,255,0,0.12)", fg: "#2a2" },
    stale:   { bg: "rgba(255,165,0,0.12)", fg: "#fa0" },
    offline: { bg: "rgba(255,0,0,0.10)", fg: "#a44" },
  };
  const c = colors[status] || colors.offline;
  return {
    fontSize: 10,
    padding: "1px 6px",
    borderRadius: 3,
    background: c.bg,
    color: c.fg,
    fontWeight: 600,
    textTransform: "uppercase",
  };
}

function routeBadge(route: string): React.CSSProperties {
  const colors: Record<string, { bg: string; fg: string }> = {
    local:  { bg: "rgba(0,255,0,0.12)", fg: "#2a2" },
    direct: { bg: "rgba(100,160,255,0.12)", fg: "#6af" },
    relay:  { bg: "rgba(255,165,0,0.12)", fg: "#fa0" },
    unknown:{ bg: "rgba(128,128,128,0.10)", fg: "#888" },
  };
  const c = colors[route] || colors.unknown;
  return {
    fontSize: 10,
    padding: "1px 6px",
    borderRadius: 3,
    background: c.bg,
    color: c.fg,
  };
}

// ── Component ─────────────────────────────────────────────────────────

export default function LibraryClient({ games, serverIds, session }: LibraryClientProps) {
  const [activeGame, setActiveGame] = useState<{ id: string; name: string } | null>(null);
  const [selectedServerId, setSelectedServerId] = useState<string>("");

  // Host picker state
  const [hostPickerGame, setHostPickerGame] = useState<string | null>(null);
  const [playableHosts, setPlayableHosts] = useState<PlayableHost[]>([]);
  const [pickerLoading, setPickerLoading] = useState(false);

  const hasServers = serverIds.length > 0;

  const handlePlay = async (gameId: string) => {
    if (!hasServers) return;

    setPickerLoading(true);
    try {
      const resp = await fetch(`/api/playable-hosts?game_id=${encodeURIComponent(gameId)}`);
      if (!resp.ok) throw new Error("failed");
      const data = await resp.json();
      const hosts: PlayableHost[] = data.hosts || [];
      setPlayableHosts(hosts);

      const withGame = hosts.filter((h) => h.has_game && h.status !== "offline");

      // Sort: online/local > online/direct > online/relay > stale
      const routeOrder: Record<string, number> = { local: 0, direct: 1, relay: 2, unknown: 3 };
      withGame.sort((a, b) => {
        if (a.status !== b.status) return a.status === "online" ? -1 : 1;
        return (routeOrder[a.route_hint] ?? 3) - (routeOrder[b.route_hint] ?? 3);
      });

      // Check preference cookie
      const preferredId = getPreferredServer(gameId);
      if (preferredId) {
        const prefIdx = withGame.findIndex((h) => h.server_id === preferredId);
        if (prefIdx > 0) {
          const [pref] = withGame.splice(prefIdx, 1);
          withGame.unshift(pref);
        }
      }

      if (withGame.length === 0) {
        // No playable hosts — show error in picker
        setHostPickerGame(gameId);
        return;
      }

      if (withGame.length === 1) {
        // Auto-select single host
        setSelectedServerId(withGame[0].server_id);
        const name = hosts.find((h) => h.server_id === withGame[0].server_id)?.name || "";
        setPreferredServer(gameId, withGame[0].server_id);
        setActiveGame({ id: gameId, name });
        return;
      }

      // Multiple hosts — show picker
      setHostPickerGame(gameId);
    } finally {
      setPickerLoading(false);
    }
  };

  const selectHost = (gameId: string, serverId: string, serverName: string) => {
    setSelectedServerId(serverId);
    setHostPickerGame(null);
    setPreferredServer(gameId, serverId);
    setActiveGame({ id: gameId, name: serverName });
  };

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
                {session && hasServers ? (
                  <button
                    style={styles.playBtn}
                    onClick={() => handlePlay(game.id)}
                    disabled={pickerLoading}
                  >
                    Play
                  </button>
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

      {/* ── Host picker ──────────────────────────────────────────── */}
      {hostPickerGame && (
        <>
          <div style={styles.backdrop} onClick={() => setHostPickerGame(null)} />
          <div style={styles.pickerPanel}>
            <h3 style={styles.pickerTitle}>Choose host</h3>
            {playableHosts.length === 0 ? (
              <p style={styles.empty}>No hosts available.</p>
            ) : (
              playableHosts.map((host) => {
                const playable = host.has_game && host.status !== "offline";
                return (
                  <div key={host.server_id} style={styles.pickerRow}>
                    <span style={styles.pickerName}>{host.name}</span>
                    <span style={statusBadge(host.status)}>{host.status}</span>
                    {host.has_game && host.route_hint !== "unknown" && (
                      <span style={routeBadge(host.route_hint)}>{host.route_hint}</span>
                    )}
                    {!host.has_game && (
                      <span style={{ fontSize: 10, color: "#666" }}>no game</span>
                    )}
                    <button
                      style={{
                        ...styles.pickerPlayBtn,
                        opacity: playable ? 1 : 0.4,
                        cursor: playable ? "pointer" : "default",
                      }}
                      disabled={!playable}
                      onClick={() => selectHost(hostPickerGame, host.server_id, host.name)}
                    >
                      {playable ? "Select" : "—"}
                    </button>
                  </div>
                );
              })
            )}
            <div style={{ marginTop: 12, textAlign: "center" }}>
              <button style={styles.btn} onClick={() => setHostPickerGame(null)}>Cancel</button>
            </div>
          </div>
        </>
      )}

      {/* Dev shortcut */}
      {session && (
        <section style={styles.section}>
          <h2 style={styles.h2}>Tools</h2>
          <a style={styles.link} href="/dev">Dev Dashboard</a>
        </section>
      )}

      {/* ── Game modal — no backdrop close, only explicit button ─── */}
      {activeGame && selectedServerId && (
        <div style={styles.modalOverlay}>
          <div style={styles.modalContent}>
            <GamePlayer
              gameId={activeGame.id}
              gameName={activeGame.name}
              serverId={selectedServerId}
              onClose={() => setActiveGame(null)}
            />
          </div>
        </div>
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
    cursor: "pointer",
    border: "none",
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
  modalOverlay: {
    position: "fixed",
    inset: 0,
    background: "rgba(0,0,0,0.95)",
    zIndex: 100,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  },
  modalContent: {
    width: "100vw",
    height: "100vh",
    position: "relative",
    overflow: "hidden",
  },
  backdrop: {
    position: "fixed",
    inset: 0,
    background: "rgba(0,0,0,0.5)",
    zIndex: 90,
  },
  pickerPanel: {
    position: "fixed",
    top: "50%",
    left: "50%",
    transform: "translate(-50%, -50%)",
    background: "#1a1a1a",
    border: "1px solid #444",
    borderRadius: 6,
    padding: "20px 24px",
    zIndex: 95,
    minWidth: 320,
    maxWidth: 480,
    maxHeight: "80vh",
    overflowY: "auto",
  },
  pickerTitle: {
    margin: "0 0 16px",
    fontSize: 16,
    color: "#fff",
  },
  pickerRow: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "8px 0",
    borderBottom: "1px solid #333",
  },
  pickerName: {
    flex: 1,
    fontSize: 14,
    color: "#ddd",
  },
  pickerPlayBtn: {
    padding: "4px 14px",
    background: "#2a2",
    color: "#000",
    border: "none",
    borderRadius: 3,
    fontSize: 12,
    fontFamily: "monospace",
    fontWeight: 700,
    cursor: "pointer",
  },
  btn: {
    padding: "4px 14px",
    background: "#333",
    color: "#ccc",
    border: "1px solid #555",
    cursor: "pointer",
    fontFamily: "monospace",
    fontSize: 13,
    borderRadius: 2,
  },
};
