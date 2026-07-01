"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { Badge, Button, Modal } from "@/components/ui";
import GameTile from "@/components/fluent/GameTile";
import AppHeader from "@/components/fluent/AppHeader";

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

  // Platform filter: empty = show all, non-empty = only selected
  const [selectedPlatforms, setSelectedPlatforms] = useState<Set<string>>(new Set());

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

  // Unique platforms from all games (for filter checkboxes)
  const uniquePlatforms = [...new Set(allGames.map((g) => g.platform))].sort();

  // Toggle a platform in/out of the filter set
  const togglePlatform = useCallback((platform: string) => {
    setSelectedPlatforms((prev) => {
      const next = new Set(prev);
      if (next.has(platform)) next.delete(platform);
      else next.add(platform);
      return next;
    });
  }, []);

  // Apply platform filter (empty set = show all)
  const filteredGames = selectedPlatforms.size === 0
    ? currentGames
    : currentGames.filter((g) => selectedPlatforms.has(g.platform));

  // ── Render ──────────────────────────────────────────────────────

  return (
    <main style={styles.main}>
      <AppHeader
        userName={session?.user?.name || session?.user?.email || undefined}
        links={[
          ...(session ? [{ label: "Dashboard", href: "/dashboard" }] : []),
          ...(session
            ? [{ label: "Sign out", href: "/api/auth/signout" }]
            : [{ label: "Sign in", href: "/api/auth/signin" }]),
        ]}
      />

      {!session && (
        <div style={styles.banner}>Sign in to play games on your server.</div>
      )}

      <section style={styles.section}>
        <h2 style={styles.h2}>Library</h2>

        {/* Tabs */}
        <div style={{ display: "flex", gap: 0, marginBottom: "var(--space-5)" }}>
          {(["all", "favorites", "recent"] as const).map((t) => {
            const isActive = tab === t;
            const counts: Record<string, number> = { all: allTotal, favorites: favTotal, recent: recentTotal };
            return (
              <button
                key={t}
                onClick={() => setTab(t)}
                style={{
                  padding: "8px 20px",
                  background: isActive ? "var(--color-sky-high)" : "transparent",
                  border: "none",
                  borderBottom: isActive ? "2px solid var(--color-accent)" : "2px solid transparent",
                  color: isActive ? "var(--color-accent)" : "var(--color-cloud-dim)",
                  fontSize: "var(--font-size-sm)",
                  fontFamily: "var(--font-mono)",
                  textTransform: "uppercase",
                  letterSpacing: "0.05em",
                  cursor: "pointer",
                  transition: "all 0.15s",
                }}
              >
                {t.charAt(0).toUpperCase() + t.slice(1)}
                {t === "all" && counts.all > 0 ? ` (${counts.all})` : ""}
                {t === "favorites" && counts.favorites > 0 ? ` (${counts.favorites})` : ""}
              </button>
            );
          })}
        </div>

        {/* Search (All tab only) */}
        {tab === "all" && (
          <input
            type="text"
            placeholder="Search games..."
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            style={{
              width: "100%",
              maxWidth: 480,
              padding: "10px 14px",
              marginBottom: "var(--space-5)",
              background: "var(--color-sky-high)",
              border: "2px solid var(--color-sky-high)",
              borderRadius: "var(--radius-sm)",
              color: "var(--color-cloud)",
              fontSize: "var(--font-size-base)",
              fontFamily: "var(--font-mono)",
              outline: "none",
              transition: "border-color 0.15s",
            }}
            onFocus={(e) => {
              e.target.style.borderColor = "var(--color-accent)";
            }}
            onBlur={(e) => {
              e.target.style.borderColor = "var(--color-sky-high)";
            }}
          />
        )}

        {/* Platform filter checkboxes (All tab only) */}
        {tab === "all" && uniquePlatforms.length > 0 && (
          <div style={{
            display: "flex",
            flexWrap: "wrap",
            gap: "var(--space-3)",
            marginBottom: "var(--space-6)",
            alignItems: "center",
          }}>
            <span style={{
              fontSize: "var(--font-size-xs)",
              color: "var(--color-cloud-dim)",
              fontFamily: "var(--font-mono)",
              textTransform: "uppercase",
              letterSpacing: "0.06em",
              marginRight: "var(--space-2)",
            }}>
              Platforms
            </span>
            {uniquePlatforms.map((platform) => {
              const checked = selectedPlatforms.has(platform);
              return (
                <label
                  key={platform}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: "4px",
                    padding: "4px 10px",
                    background: checked ? "rgba(56,189,248,0.12)" : "transparent",
                    border: checked
                      ? "1px solid rgba(56,189,248,0.3)"
                      : "1px solid var(--color-sky-high)",
                    borderRadius: "2px",
                    cursor: "pointer",
                    fontSize: "var(--font-size-xs)",
                    fontFamily: "var(--font-mono)",
                    color: checked ? "var(--color-accent)" : "var(--color-cloud-dim)",
                    transition: "all 0.15s",
                    userSelect: "none",
                  }}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => togglePlatform(platform)}
                    style={{
                      accentColor: "var(--color-accent)",
                      margin: 0,
                      width: 12,
                      height: 12,
                      cursor: "pointer",
                    }}
                  />
                  {platform}
                </label>
              );
            })}
            {selectedPlatforms.size > 0 && (
              <button
                onClick={() => setSelectedPlatforms(new Set())}
                style={{
                  background: "none",
                  border: "none",
                  color: "var(--color-cloud-dim)",
                  fontSize: "var(--font-size-xs)",
                  fontFamily: "var(--font-mono)",
                  cursor: "pointer",
                  padding: "4px 6px",
                  textDecoration: "underline",
                }}
              >
                clear
              </button>
            )}
          </div>
        )}

        {/* Game grid */}
        {filteredGames.length === 0 && !currentLoading ? (
          <p style={styles.empty}>
            {selectedPlatforms.size > 0
              ? "No games match the selected platforms."
              : tab === "all" ? "No games found." : tab === "favorites" ? "No favorites yet." : "No recent plays."}
          </p>
        ) : (
          <div className="game-tile-grid">
            {filteredGames.map((game) => (
              <GameTile
                key={game.id}
                game={game}
                size="square"
                isFavorite={favoriteIds.has(game.id)}
                onPlay={handlePlay}
                onToggleFavorite={session ? handleToggleFavorite : undefined}
                onEdit={startRename}
              />
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

      {/* ── Rename modal ────────────────────────────────────────── */}
      <Modal open={editingGame !== null} onClose={cancelRename} title="Rename game">
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-4)" }}>
          <input
            type="text"
            value={editName}
            onChange={(e) => setEditName(e.target.value)}
            onKeyDown={(e) => editingGame && handleEditKey(e, editingGame)}
            autoFocus
            disabled={editSaving}
            style={{
              padding: "10px 14px",
              background: "var(--color-sky-high)",
              border: "2px solid var(--color-sky-high)",
              borderRadius: "var(--radius-sm)",
              color: "var(--color-cloud)",
              fontSize: "var(--font-size-base)",
              fontFamily: "var(--font-mono)",
              outline: "none",
            }}
            onFocus={(e) => { e.target.style.borderColor = "var(--color-accent)"; }}
            onBlur={(e) => { e.target.style.borderColor = "var(--color-sky-high)"; }}
          />
          <div style={{ display: "flex", gap: "var(--space-3)", justifyContent: "flex-end" }}>
            <Button variant="secondary" onClick={cancelRename}>
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={() => editingGame && saveRename(editingGame)}
              disabled={editSaving || !editName.trim()}
            >
              {editSaving ? "Saving..." : "Save"}
            </Button>
          </div>
        </div>
      </Modal>

    </main>
  );
}

// ── Styles ──────────────────────────────────────────────────────────

const styles: Record<string, React.CSSProperties> = {
  main: {
    padding: "0",
    fontFamily: "var(--font-mono)",
    background: "var(--color-sky-deep)",
    color: "var(--color-cloud)",
    minHeight: "100vh",
  },
  banner: {
    padding: "12px 24px",
    background: "var(--color-infoBg)",
    borderBottom: "2px solid var(--color-accent)",
    fontSize: "var(--font-size-base)",
    color: "var(--color-accent)",
    fontFamily: "var(--font-mono)",
  },
  section: { padding: "0 24px", marginBottom: "var(--space-8)" },
  h2: {
    margin: "0 0 var(--space-6)",
    fontSize: "var(--font-size-lg)",
    fontWeight: 600,
    color: "var(--color-accent)",
    fontFamily: "var(--font-mono)",
    textTransform: "uppercase",
    letterSpacing: "0.05em",
  },
  empty: { fontSize: "var(--font-size-base)", color: "var(--color-cloud-dim)", fontStyle: "italic" },

  loading: {
    textAlign: "center" as const,
    padding: "var(--space-8)",
    color: "var(--color-cloud-dim)",
    fontSize: "var(--font-size-base)",
  },
  sentinel: { height: "1px" },

  // Picker
  pickerRow: {
    display: "flex", alignItems: "center", gap: "var(--space-4)",
    padding: "var(--space-4) 0", borderBottom: "1px solid var(--color-sky-high)",
  },
  pickerName: { flex: 1, fontSize: "var(--font-size-md)", color: "var(--color-cloud)", fontFamily: "var(--font-mono)" },
};
