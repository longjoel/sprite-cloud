"use client";

import { useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { Badge, Button, Card, Modal } from "@/components/ui";

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

function statusVariant(status: string) {
  const map: Record<string, "success" | "warning" | "error"> = {
    online: "success",
    stale: "warning",
    offline: "error",
  };
  return map[status] || "error";
}

function routeVariant(route: string) {
  const map: Record<string, "success" | "info" | "warning" | "muted"> = {
    local: "success",
    direct: "info",
    relay: "warning",
    unknown: "muted",
  };
  return map[route] || "muted";
}

function csrfHeaders(): Record<string, string> {
  let token = document.cookie
    .split(";")
    .map((p) => p.trim())
    .find((p) => p.startsWith("gv_csrf_token="))
    ?.split("=")
    .slice(1)
    .join("=");
  if (!token) {
    token = crypto.randomUUID();
    document.cookie = `gv_csrf_token=${encodeURIComponent(token)}; Path=/; SameSite=Lax`;
  }
  return { "Content-Type": "application/json", "x-csrf-token": decodeURIComponent(token) };
}

// ── Component ─────────────────────────────────────────────────────────

export default function LibraryClient({ games, serverIds, session }: LibraryClientProps) {
  const router = useRouter();

  // Host picker state
  const [hostPickerGame, setHostPickerGame] = useState<string | null>(null);
  const [playableHosts, setPlayableHosts] = useState<PlayableHost[]>([]);
  const [pickerLoading, setPickerLoading] = useState(false);

  // Edit state
  const [editingGame, setEditingGame] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editSaving, setEditSaving] = useState(false);

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
        // Auto-select single host — redirect to worker proxy
        const sid = withGame[0].server_id;
        setPreferredServer(gameId, sid);
        router.push(`/api/worker-proxy/${encodeURIComponent(gameId)}/?server_id=${encodeURIComponent(sid)}`);
        return;
      }

      // Multiple hosts — show picker
      setHostPickerGame(gameId);
    } finally {
      setPickerLoading(false);
    }
  };

  const selectHost = (gameId: string, serverId: string, _serverName: string) => {
    setHostPickerGame(null);
    setPreferredServer(gameId, serverId);
    router.push(`/api/worker-proxy/${encodeURIComponent(gameId)}/?server_id=${encodeURIComponent(serverId)}`);
  };

  const startRename = useCallback((game: Game) => {
    setEditingGame(game.id);
    setEditName(game.name);
  }, []);

  const cancelRename = useCallback(() => {
    setEditingGame(null);
    setEditName("");
  }, []);

  const saveRename = useCallback(async (gameId: string) => {
    const trimmed = editName.trim();
    if (!trimmed || trimmed === games.find((g) => g.id === gameId)?.name) {
      cancelRename();
      return;
    }
    setEditSaving(true);
    try {
      const resp = await fetch(`/api/games/${gameId}`, {
        method: "PUT",
        headers: csrfHeaders(),
        body: JSON.stringify({ name: trimmed }),
      });
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        throw new Error(err.error || `HTTP ${resp.status}`);
      }
      // Update local state
      const idx = games.findIndex((g) => g.id === gameId);
      if (idx !== -1) games[idx].name = trimmed;
      cancelRename();
    } catch (e: unknown) {
      // Keep editing on error — user can retry
      setEditSaving(false);
    }
  }, [editName, games, cancelRename]);

  // Key handler for inline edit
  const handleEditKey = useCallback((e: React.KeyboardEvent, gameId: string) => {
    if (e.key === "Enter") saveRename(gameId);
    if (e.key === "Escape") cancelRename();
  }, [saveRename, cancelRename]);

  return (
    <main style={styles.main}>
      <div style={styles.topBar}>
        <h1 style={styles.title}>Games Vault</h1>
        {session ? (
          <div style={styles.userInfo}>
            <span style={styles.userName}>
              {session.user?.name || session.user?.email || "User"}
            </span>
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
              <Card key={game.id} style={{ display: "flex", flexDirection: "column" }}>
                {editingGame === game.id ? (
                  <input
                    type="text"
                    value={editName}
                    onChange={(e) => setEditName(e.target.value)}
                    onKeyDown={(e) => handleEditKey(e, game.id)}
                    onBlur={() => saveRename(game.id)}
                    disabled={editSaving}
                    autoFocus
                    style={styles.editInput}
                    maxLength={200}
                  />
                ) : (
                  <div style={styles.cardTitleRow}>
                    <div style={styles.cardTitle}>{game.name}</div>
                    {session && (
                      <button
                        onClick={() => startRename(game)}
                        style={styles.editBtn}
                        title="Rename"
                      >
                        ✎
                      </button>
                    )}
                  </div>
                )}
                <div style={styles.cardMeta}>{game.platform} · {game.maxPlayers}p</div>
                <div style={{ marginTop: "auto" }}>
                  {session && hasServers ? (
                    <Button
                      variant="primary"
                      onClick={() => handlePlay(game.id)}
                      disabled={pickerLoading}
                    >
                      Play
                    </Button>
                  ) : (
                    <span style={styles.playBtnDisabled}>
                      {!session ? "Sign in" : "No server"}
                    </span>
                  )}
                </div>
              </Card>
            ))}
          </div>
        )}
      </section>

      {/* ── Host picker ──────────────────────────────────────────── */}
      <Modal
        open={hostPickerGame !== null}
        onClose={() => setHostPickerGame(null)}
        title="Choose host"
      >
        {playableHosts.length === 0 ? (
          <p style={styles.empty}>No hosts available.</p>
        ) : (
          playableHosts.map((host) => {
            const playable = host.has_game && host.status !== "offline";
            return (
              <div key={host.server_id} style={styles.pickerRow}>
                <span style={styles.pickerName}>{host.name}</span>
                <Badge variant={statusVariant(host.status)}>
                  {host.status}
                </Badge>
                {host.has_game && host.route_hint !== "unknown" && (
                  <Badge variant={routeVariant(host.route_hint)}>
                    {host.route_hint}
                  </Badge>
                )}
                {!host.has_game && (
                  <span style={{ fontSize: "var(--font-size-xs)", color: "var(--color-muted)" }}>
                    no game
                  </span>
                )}
                <Button
                  variant="primary"
                  size="sm"
                  disabled={!playable}
                  onClick={() => selectHost(hostPickerGame!, host.server_id, host.name)}
                  style={{ opacity: playable ? 1 : 0.4, cursor: playable ? "pointer" : "default" }}
                >
                  {playable ? "Select" : "—"}
                </Button>
              </div>
            );
          })
        )}
        <div style={{ marginTop: "var(--space-5)", textAlign: "center" }}>
          <Button variant="secondary" onClick={() => setHostPickerGame(null)}>
            Cancel
          </Button>
        </div>
      </Modal>

      {/* Dev shortcut */}
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
    padding: "var(--space-8)",
    fontFamily: "var(--font-mono)",
    background: "var(--color-mahogany)",
    color: "var(--color-cream)",
    minHeight: "100vh",
  },
  topBar: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: "var(--space-8)",
  },
  title: {
    margin: 0,
    fontSize: "var(--font-size-h1)",
    color: "var(--color-brass)",
    fontFamily: "var(--font-mono)",
  },
  userInfo: {
    display: "flex",
    alignItems: "center",
    gap: "var(--space-6)",
  },
  userName: {
    fontSize: "var(--font-size-base)",
    color: "var(--color-muted)",
  },
  link: {
    color: "var(--color-info)",
    textDecoration: "none",
    fontSize: "var(--font-size-base)",
    fontFamily: "var(--font-mono)",
  },
  banner: {
    padding: "var(--space-5) var(--space-6)",
    background: "var(--color-infoBg)",
    border: "1px solid var(--color-info)",
    borderRadius: "var(--radius-md)",
    marginBottom: "var(--space-8)",
    fontSize: "var(--font-size-base)",
    color: "var(--color-info)",
  },
  section: { marginBottom: "var(--space-8)" },
  h2: {
    margin: "0 0 var(--space-6)",
    fontSize: "var(--font-size-h2)",
    color: "var(--color-muted)",
    fontFamily: "var(--font-mono)",
  },
  empty: {
    fontSize: "var(--font-size-base)",
    color: "var(--color-muted)",
    fontStyle: "italic",
  },
  grid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))",
    gap: "var(--space-5)",
  },
  cardTitle: {
    fontSize: "var(--font-size-lg)",
    color: "var(--color-cream)",
    fontFamily: "var(--font-mono)",
    marginBottom: 0,
  },
  cardTitleRow: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: "var(--space-2)",
  },
  editBtn: {
    background: "none",
    border: "1px solid var(--color-bamboo)",
    borderRadius: "var(--radius-sm)",
    color: "var(--color-muted)",
    cursor: "pointer",
    fontSize: "var(--font-size-base)",
    padding: "0 var(--space-2)",
    lineHeight: "1.4",
    fontFamily: "var(--font-mono)",
  },
  editInput: {
    fontSize: "var(--font-size-lg)",
    fontFamily: "var(--font-mono)",
    background: "var(--color-mahogany)",
    color: "var(--color-cream)",
    border: "1px solid var(--color-info)",
    borderRadius: "var(--radius-sm)",
    padding: "var(--space-1) var(--space-2)",
    marginBottom: "var(--space-2)",
    outline: "none",
    width: "100%",
  },
  cardMeta: {
    fontSize: "var(--font-size-xs)",
    color: "var(--color-muted)",
    marginBottom: "var(--space-5)",
  },
  playBtnDisabled: {
    display: "inline-block",
    padding: "4px 14px",
    background: "var(--color-walnut)",
    color: "var(--color-muted)",
    borderRadius: "var(--radius-sm)",
    fontSize: "var(--font-size-base)",
    fontFamily: "var(--font-mono)",
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
  pickerRow: {
    display: "flex",
    alignItems: "center",
    gap: "var(--space-4)",
    padding: "var(--space-4) 0",
    borderBottom: "1px solid var(--color-bamboo)",
  },
  pickerName: {
    flex: 1,
    fontSize: "var(--font-size-md)",
    color: "var(--color-cream)",
    fontFamily: "var(--font-mono)",
  },
};
