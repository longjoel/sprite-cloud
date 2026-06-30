"use client";

import { useState, useCallback, useEffect, useRef } from "react";
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
  status: string;
  has_game: boolean;
  route_hint: string;
}

interface LibraryClientProps {
  serverIds: string[];
  session: { user?: { id?: string; name?: string | null; email?: string | null } } | null;
}

const PAGE_SIZE = 100;

// ── Helpers ───────────────────────────────────────────────────────────

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
    online: "success", stale: "warning", offline: "error",
  };
  return map[status] || "error";
}

function routeVariant(route: string) {
  const map: Record<string, "success" | "info" | "warning" | "muted"> = {
    local: "success", direct: "info", relay: "warning", unknown: "muted",
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

// ── Favorites helpers ─────────────────────────────────────────────────

async function fetchFavoriteIds(): Promise<Set<string>> {
  try {
    // Fetch first page of favorites to get IDs for star display
    const resp = await fetch("/api/favorites?limit=200");
    if (!resp.ok) return new Set();
    const data = await resp.json();
    return new Set((data.games || []).map((g: Game) => g.id));
  } catch {
    return new Set();
  }
}

async function toggleFavorite(gameId: string): Promise<boolean> {
  const resp = await fetch("/api/favorites", {
    method: "POST",
    headers: csrfHeaders(),
    body: JSON.stringify({ gameId }),
  });
  const data = await resp.json();
  return data.favorited;
}

async function recordRecentPlay(gameId: string) {
  try {
    await fetch("/api/recent-plays", {
      method: "POST",
      headers: csrfHeaders(),
      body: JSON.stringify({ gameId }),
    });
  } catch { /* fire-and-forget */ }
}

// ── Component ─────────────────────────────────────────────────────────

export default function LibraryClient({ serverIds, session }: LibraryClientProps) {
  const router = useRouter();

  // Host picker state (still needed for multi-server selection)
  const [hostPickerGame, setHostPickerGame] = useState<string | null>(null);
  const [playableHosts, setPlayableHosts] = useState<PlayableHost[]>([]);
  const [pickerLoading, setPickerLoading] = useState(false);

  // Edit state
  const [editingGame, setEditingGame] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editSaving, setEditSaving] = useState(false);

  // ── Library state ───────────────────────────────────────────────
  const [tab, setTab] = useState<"all" | "favorites" | "recent">("all");
  const [search, setSearch] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const searchTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const [allGames, setAllGames] = useState<Game[]>([]);
  const [allTotal, setAllTotal] = useState(0);
  const [allLoading, setAllLoading] = useState(false);

  const [favGames, setFavGames] = useState<Game[]>([]);
  const [favTotal, setFavTotal] = useState(0);
  const [favLoading, setFavLoading] = useState(false);

  const [recentGames, setRecentGames] = useState<Game[]>([]);
  const [recentTotal, setRecentTotal] = useState(0);
  const [recentLoading, setRecentLoading] = useState(false);

  const [favoriteIds, setFavoriteIds] = useState<Set<string>>(new Set());

  const sentinelRef = useRef<HTMLDivElement>(null);
  const hasServers = serverIds.length > 0;

  // Load favorite IDs on mount
  useEffect(() => {
    if (session?.user?.id) {
      fetchFavoriteIds().then(setFavoriteIds);
    }
  }, [session?.user?.id]);

  // Debounced search
  useEffect(() => {
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => {
      setSearch(searchInput);
    }, 300);
    return () => { if (searchTimer.current) clearTimeout(searchTimer.current); };
  }, [searchInput]);

  // ── Fetch helpers ───────────────────────────────────────────────

  const fetchPage = useCallback(async (endpoint: string, params: Record<string, string>) => {
    const url = new URL(endpoint, window.location.origin);
    Object.entries(params).forEach(([k, v]) => { if (v) url.searchParams.set(k, v); });
    const resp = await fetch(url.toString());
    if (!resp.ok) throw new Error("fetch failed");
    return resp.json();
  }, []);

  // Load all games
  const loadAllGames = useCallback(async (reset: boolean, searchTerm: string, current: Game[], total: number) => {
    if (allLoading) return;
    const offset = reset ? 0 : current.length;
    if (!reset && offset >= total && total > 0) return;
    setAllLoading(true);
    try {
      const data = await fetchPage("/api/games", {
        limit: String(PAGE_SIZE),
        offset: String(offset),
        search: searchTerm,
      });
      setAllGames(reset ? data.games : [...current, ...data.games]);
      setAllTotal(data.total);
    } finally {
      setAllLoading(false);
    }
  }, [allLoading, fetchPage]);

  // Load favorites
  const loadFavorites = useCallback(async (reset: boolean, current: Game[], total: number) => {
    if (favLoading) return;
    const offset = reset ? 0 : current.length;
    if (!reset && offset >= total && total > 0) return;
    setFavLoading(true);
    try {
      const data = await fetchPage("/api/favorites", {
        limit: String(PAGE_SIZE),
        offset: String(offset),
      });
      setFavGames(reset ? data.games : [...current, ...data.games]);
      setFavTotal(data.total);
    } finally {
      setFavLoading(false);
    }
  }, [favLoading, fetchPage]);

  // Load recent plays
  const loadRecent = useCallback(async (reset: boolean, current: Game[], total: number) => {
    if (recentLoading) return;
    const offset = reset ? 0 : current.length;
    if (!reset && offset >= total && total > 0) return;
    setRecentLoading(true);
    try {
      const data = await fetchPage("/api/recent-plays", {
        limit: String(PAGE_SIZE),
        offset: String(offset),
      });
      setRecentGames(reset ? data.games : [...current, ...data.games]);
      setRecentTotal(data.total);
    } finally {
      setRecentLoading(false);
    }
  }, [recentLoading, fetchPage]);

  // Initial load + search reset
  useEffect(() => {
    if (!hasServers) return;
    loadAllGames(true, search, [], 0);
  }, [search, hasServers]);

  // Initial load for favorites/recent when tab changes
  useEffect(() => {
    if (!hasServers || !session?.user?.id) return;
    if (tab === "favorites" && favGames.length === 0) loadFavorites(true, [], 0);
    if (tab === "recent" && recentGames.length === 0) loadRecent(true, [], 0);
  }, [tab, hasServers, session?.user?.id]);

  // ── Infinite scroll sentinel ────────────────────────────────────

  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) {
          if (tab === "all" && allGames.length < allTotal) {
            loadAllGames(false, search, allGames, allTotal);
          } else if (tab === "favorites" && favGames.length < favTotal) {
            loadFavorites(false, favGames, favTotal);
          } else if (tab === "recent" && recentGames.length < recentTotal) {
            loadRecent(false, recentGames, recentTotal);
          }
        }
      },
      { threshold: 0.1 },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [tab, allGames.length, allTotal, favGames.length, favTotal, recentGames.length, recentTotal, search]);

  // ── Play handler ─────────────────────────────────────────────────

  const navigateToGame = useCallback(async (gameId: string, serverId: string) => {
    const hostToken = crypto.randomUUID();
    const resp = await fetch("/api/room/shorten", {
      method: "POST",
      headers: csrfHeaders(),
      body: JSON.stringify({ game_id: gameId, host_token: hostToken, server_id: serverId }),
    });
    if (!resp.ok) throw new Error("shorten failed");
    const data = await resp.json();
    router.push(`/p/${data.code}`);
  }, [router]);

  const handlePlay = async (gameId: string) => {
    if (!hasServers) return;
    recordRecentPlay(gameId);
    setPickerLoading(true);
    try {
      const resp = await fetch(`/api/playable-hosts?game_id=${encodeURIComponent(gameId)}`);
      if (!resp.ok) throw new Error("failed");
      const data = await resp.json();
      const hosts: PlayableHost[] = data.hosts || [];
      setPlayableHosts(hosts);

      const withGame = hosts.filter((h) => h.has_game && h.status !== "offline");
      const routeOrder: Record<string, number> = { local: 0, direct: 1, relay: 2, unknown: 3 };
      withGame.sort((a, b) => {
        if (a.status !== b.status) return a.status === "online" ? -1 : 1;
        return (routeOrder[a.route_hint] ?? 3) - (routeOrder[b.route_hint] ?? 3);
      });

      const preferredId = getPreferredServer(gameId);
      if (preferredId) {
        const prefIdx = withGame.findIndex((h) => h.server_id === preferredId);
        if (prefIdx > 0) {
          const [pref] = withGame.splice(prefIdx, 1);
          withGame.unshift(pref);
        }
      }

      if (withGame.length === 0) {
        setHostPickerGame(gameId);
        return;
      }

      if (withGame.length === 1) {
        const serverId = withGame[0].server_id;
        setPreferredServer(gameId, serverId);
        await navigateToGame(gameId, serverId);
        return;
      }

      setHostPickerGame(gameId);
    } catch {
      // navigateToGame/shorten failure is silent — user stays on library
    } finally {
      setPickerLoading(false);
    }
  };

  const selectHost = async (gameId: string, serverId: string, _serverName: string) => {
    setHostPickerGame(null);
    setPreferredServer(gameId, serverId);
    try {
      await navigateToGame(gameId, serverId);
    } catch { /* silent */ }
  };

  // ── Rename handlers ─────────────────────────────────────────────

  const startRename = useCallback((game: Game) => {
    setEditingGame(game.id);
    setEditName(game.name);
  }, []);

  const cancelRename = useCallback(() => {
    setEditingGame(null);
    setEditName("");
  }, []);

  // We need the full games list for rename lookup — use allGames
  const allGamesRef = allGames;

  const saveRename = useCallback(async (gameId: string) => {
    const trimmed = editName.trim();
    if (!trimmed || trimmed === allGamesRef.find((g) => g.id === gameId)?.name) {
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
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      // Update local state in all lists
      const update = (list: Game[]) => list.map((g) => g.id === gameId ? { ...g, name: trimmed } : g);
      setAllGames(update);
      setFavGames(update);
      setRecentGames(update);
      cancelRename();
    } catch {
      setEditSaving(false);
    }
  }, [editName, allGamesRef, cancelRename]);

  const handleEditKey = useCallback((e: React.KeyboardEvent, gameId: string) => {
    if (e.key === "Enter") saveRename(gameId);
    if (e.key === "Escape") cancelRename();
  }, [saveRename, cancelRename]);

  // ── Favorite toggle ─────────────────────────────────────────────

  const handleToggleFavorite = useCallback(async (gameId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const newState = await toggleFavorite(gameId);
    setFavoriteIds((prev) => {
      const next = new Set(prev);
      if (newState) next.add(gameId);
      else next.delete(gameId);
      return next;
    });
    // If unfavoriting from the favorites tab, remove from list
    if (!newState && tab === "favorites") {
      setFavGames((prev) => prev.filter((g) => g.id !== gameId));
      setFavTotal((prev) => prev - 1);
    }
  }, [tab]);

  // ── Current tab's game list ─────────────────────────────────────

  const currentGames = tab === "all" ? allGames : tab === "favorites" ? favGames : recentGames;
  const currentTotal = tab === "all" ? allTotal : tab === "favorites" ? favTotal : recentTotal;
  const currentLoading = tab === "all" ? allLoading : tab === "favorites" ? favLoading : recentLoading;
  const hasMore = currentGames.length < currentTotal;

  // ── Render ──────────────────────────────────────────────────────

  const tabStyle = (t: typeof tab) => ({
    ...styles.tab,
    ...(tab === t ? styles.tabActive : {}),
  });

  return (
    <main style={styles.main}>
      <div style={styles.topBar}>
        <h1 style={styles.title}>Sprite Cloud</h1>
        {session ? (
          <div style={styles.userInfo}>
            <span style={styles.userName}>
              {session.user?.name || session.user?.email || "User"}
            </span>
            <a style={styles.link} href="/settings">Settings</a>
            <a style={styles.link} href="/api/auth/signout">Sign out</a>
          </div>
        ) : (
          <a style={styles.link} href="/api/auth/signin">Sign in</a>
        )}
      </div>

      {!session && (
        <div style={styles.banner}>Sign in to play games on your server.</div>
      )}

      <section style={styles.section}>
        <h2 style={styles.h2}>Library</h2>

        {/* Tabs */}
        <div style={styles.tabBar}>
          <button style={tabStyle("all")} onClick={() => setTab("all")}>
            All{allTotal > 0 ? ` (${allTotal})` : ""}
          </button>
          <button style={tabStyle("favorites")} onClick={() => setTab("favorites")}>
            Favorites{favTotal > 0 ? ` (${favTotal})` : ""}
          </button>
          <button style={tabStyle("recent")} onClick={() => setTab("recent")}>
            Recent
          </button>
        </div>

        {/* Search (All tab only) */}
        {tab === "all" && (
          <input
            type="text"
            placeholder="Search games..."
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            style={styles.searchInput}
          />
        )}

        {/* Game grid */}
        {currentGames.length === 0 && !currentLoading ? (
          <p style={styles.empty}>
            {tab === "all" ? "No games found." : tab === "favorites" ? "No favorites yet." : "No recent plays."}
          </p>
        ) : (
          <div style={styles.grid}>
            {currentGames.map((game) => (
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
                    <div style={styles.cardActions}>
                      {session && (
                        <button
                          onClick={(e) => handleToggleFavorite(game.id, e)}
                          style={{
                            ...styles.starBtn,
                            color: favoriteIds.has(game.id) ? "var(--color-brass)" : "var(--color-muted)",
                          }}
                          title={favoriteIds.has(game.id) ? "Remove favorite" : "Add favorite"}
                        >
                          {favoriteIds.has(game.id) ? "★" : "☆"}
                        </button>
                      )}
                      {session && (
                        <button onClick={() => startRename(game)} style={styles.editBtn} title="Rename">✎</button>
                      )}
                    </div>
                  </div>
                )}
                <div style={styles.cardMeta}>{game.platform} · {game.maxPlayers}p</div>
                <div style={{ marginTop: "auto" }}>
                  {session && hasServers ? (
                    <Button variant="primary" onClick={() => handlePlay(game.id)} disabled={pickerLoading}>
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

        {/* Loading indicator */}
        {currentLoading && (
          <div style={styles.loading}>Loading...</div>
        )}

        {/* Infinite scroll sentinel */}
        {hasMore && !currentLoading && (
          <div ref={sentinelRef} style={styles.sentinel} />
        )}
      </section>

      {/* ── Host picker ──────────────────────────────────────────── */}
      <Modal open={hostPickerGame !== null} onClose={() => setHostPickerGame(null)} title="Choose host">
        {playableHosts.length === 0 ? (
          <p style={styles.empty}>No hosts available.</p>
        ) : (
          playableHosts.map((host) => {
            const playable = host.has_game && host.status !== "offline";
            return (
              <div key={host.server_id} style={styles.pickerRow}>
                <span style={styles.pickerName}>{host.name}</span>
                <Badge variant={statusVariant(host.status)}>{host.status}</Badge>
                {host.has_game && host.route_hint !== "unknown" && (
                  <Badge variant={routeVariant(host.route_hint)}>{host.route_hint}</Badge>
                )}
                {!host.has_game && (
                  <span style={{ fontSize: "var(--font-size-xs)", color: "var(--color-muted)" }}>no game</span>
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
          <Button variant="secondary" onClick={() => setHostPickerGame(null)}>Cancel</Button>
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
    display: "flex", justifyContent: "space-between", alignItems: "center",
    marginBottom: "var(--space-8)",
  },
  title: {
    margin: 0, fontSize: "var(--font-size-h1)", color: "var(--color-brass)",
    fontFamily: "var(--font-mono)",
  },
  userInfo: { display: "flex", alignItems: "center", gap: "var(--space-6)" },
  userName: { fontSize: "var(--font-size-base)", color: "var(--color-muted)" },
  link: { color: "var(--color-info)", textDecoration: "none", fontSize: "var(--font-size-base)", fontFamily: "var(--font-mono)" },
  banner: {
    padding: "var(--space-5) var(--space-6)", background: "var(--color-infoBg)",
    border: "1px solid var(--color-info)", borderRadius: "var(--radius-md)",
    marginBottom: "var(--space-8)", fontSize: "var(--font-size-base)", color: "var(--color-info)",
  },
  section: { marginBottom: "var(--space-8)" },
  h2: { margin: "0 0 var(--space-6)", fontSize: "var(--font-size-h2)", color: "var(--color-muted)", fontFamily: "var(--font-mono)" },
  empty: { fontSize: "var(--font-size-base)", color: "var(--color-muted)", fontStyle: "italic" },

  // Tabs
  tabBar: { display: "flex", gap: "var(--space-2)", marginBottom: "var(--space-4)" },
  tab: {
    padding: "var(--space-2) var(--space-4)",
    background: "transparent",
    border: "1px solid var(--color-bamboo)",
    borderRadius: "var(--radius-sm)",
    color: "var(--color-muted)",
    cursor: "pointer",
    fontSize: "var(--font-size-base)",
    fontFamily: "var(--font-mono)",
  },
  tabActive: { borderColor: "var(--color-brass)", color: "var(--color-brass)" },

  // Search
  searchInput: {
    width: "100%",
    padding: "var(--space-2) var(--space-3)",
    marginBottom: "var(--space-4)",
    background: "var(--color-mahogany)",
    border: "1px solid var(--color-bamboo)",
    borderRadius: "var(--radius-sm)",
    color: "var(--color-cream)",
    fontSize: "var(--font-size-base)",
    fontFamily: "var(--font-mono)",
    outline: "none",
  },

  // Grid
  grid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))",
    gap: "var(--space-5)",
  },
  cardTitle: { fontSize: "var(--font-size-lg)", color: "var(--color-cream)", fontFamily: "var(--font-mono)", marginBottom: 0 },
  cardTitleRow: { display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "var(--space-2)" },
  cardActions: { display: "flex", alignItems: "center", gap: "var(--space-2)" },
  cardMeta: { fontSize: "var(--font-size-xs)", color: "var(--color-muted)", marginBottom: "var(--space-5)" },
  editBtn: {
    background: "none", border: "1px solid var(--color-bamboo)", borderRadius: "var(--radius-sm)",
    color: "var(--color-muted)", cursor: "pointer", fontSize: "var(--font-size-base)",
    padding: "0 var(--space-2)", lineHeight: "1.4", fontFamily: "var(--font-mono)",
  },
  starBtn: {
    background: "none", border: "none", cursor: "pointer",
    fontSize: "var(--font-size-lg)", padding: "0 var(--space-1)", lineHeight: "1",
    fontFamily: "var(--font-mono)",
  },
  editInput: {
    fontSize: "var(--font-size-lg)", fontFamily: "var(--font-mono)",
    background: "var(--color-mahogany)", color: "var(--color-cream)",
    border: "1px solid var(--color-info)", borderRadius: "var(--radius-sm)",
    padding: "var(--space-1) var(--space-2)", marginBottom: "var(--space-2)",
    outline: "none", width: "100%",
  },
  playBtnDisabled: {
    display: "inline-block", padding: "4px 14px",
    background: "var(--color-walnut)", color: "var(--color-muted)",
    borderRadius: "var(--radius-sm)", fontSize: "var(--font-size-base)", fontFamily: "var(--font-mono)",
  },
  loading: {
    textAlign: "center", padding: "var(--space-8)",
    color: "var(--color-muted)", fontSize: "var(--font-size-base)",
  },
  sentinel: { height: "1px" },

  // Picker
  pickerRow: {
    display: "flex", alignItems: "center", gap: "var(--space-4)",
    padding: "var(--space-4) 0", borderBottom: "1px solid var(--color-bamboo)",
  },
  pickerName: { flex: 1, fontSize: "var(--font-size-md)", color: "var(--color-cream)", fontFamily: "var(--font-mono)" },
};
