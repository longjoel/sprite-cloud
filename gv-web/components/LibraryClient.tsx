"use client";

import { useState, useCallback, useEffect, useRef, useMemo } from "react";
import { useRouter } from "next/navigation";
import { Badge, Button, Modal } from "@/components/ui";
import GameTile from "@/components/fluent/GameTile";
import AppHeader from "@/components/fluent/AppHeader";
import { buildLanPlayerLaunchUrl } from "@/lib/lan/launch";
import { probeLanHealth, type LanProbeResult } from "@/lib/lan/probe";

// ── Types ─────────────────────────────────────────────────────────────

interface Game {
  id: string;
  name: string;
  platform: string;
  maxPlayers: number;
}

interface GameActionModel {
  canFavorite: boolean;
  canPin: boolean;
  canRename: boolean;
  isFavorite: (gameId: string) => boolean;
  isPinned: (gameId: string) => boolean;
  onPlay: (gameId: string) => void;
  onToggleFavorite?: (gameId: string, e: React.MouseEvent) => void;
  onTogglePin?: (gameId: string, e: React.MouseEvent) => void;
  onRename?: (game: Game) => void;
}

interface PlayableHost {
  server_id: string;
  name: string;
  status: string;
  has_game: boolean;
  route_hint: string;
  lan?: {
    player_port?: number;
    player_urls?: string[];
    health_urls?: string[];
  } | null;
}

interface LibraryClientProps {
  serverIds: string[];
  session: { user?: { id?: string; name?: string | null; email?: string | null } } | null;
}

const PAGE_SIZE = 100;
const MAX_PINS = 20;

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

async function togglePin(gameId: string): Promise<{ pinned: boolean; pinCount: number }> {
  const resp = await fetch("/api/pins", {
    method: "POST",
    headers: csrfHeaders(),
    body: JSON.stringify({ gameId }),
  });
  return resp.json();
}

async function fetchPinnedIds(): Promise<Set<string>> {
  try {
    const resp = await fetch("/api/pins?ids_only=true");
    if (!resp.ok) return new Set();
    const data = await resp.json();
    return new Set(data.ids || []);
  } catch {
    return new Set();
  }
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

  const [hostPickerGame, setHostPickerGame] = useState<string | null>(null);
  const [playableHosts, setPlayableHosts] = useState<PlayableHost[]>([]);
  const [lanProbeByServer, setLanProbeByServer] = useState<Record<string, LanProbeResult>>({});

  const [editingGame, setEditingGame] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editSaving, setEditSaving] = useState(false);

  const [tab, setTab] = useState<"all" | "favorites" | "recent">("all");
  const [search, setSearch] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const searchTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // Platform filter: empty = show all
  const [selectedPlatforms, setSelectedPlatforms] = useState<Set<string>>(new Set());
  const [platformDropdownOpen, setPlatformDropdownOpen] = useState(false);

  // View toggle: "grid" | "table"
  const [viewMode, setViewMode] = useState<"grid" | "table">("grid");

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
  const [pinnedIds, setPinnedIds] = useState<Set<string>>(new Set());

  const sentinelRef = useRef<HTMLDivElement>(null);
  const filterRef = useRef<HTMLDivElement>(null);
  const hasServers = serverIds.length > 0;

  // Load favs + pins on mount
  useEffect(() => {
    if (session?.user?.id) {
      fetchFavoriteIds().then(setFavoriteIds);
      fetchPinnedIds().then(setPinnedIds);
    }
  }, [session?.user?.id]);

  // Close platform dropdown on outside click
  useEffect(() => {
    if (!platformDropdownOpen) return;
    const handler = (e: MouseEvent) => {
      if (filterRef.current && !filterRef.current.contains(e.target as Node)) {
        setPlatformDropdownOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [platformDropdownOpen]);

  // Debounced search
  useEffect(() => {
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => setSearch(searchInput), 300);
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

  const loadFavorites = useCallback(async (reset: boolean, current: Game[], total: number) => {
    if (favLoading) return;
    const offset = reset ? 0 : current.length;
    if (!reset && offset >= total && total > 0) return;
    setFavLoading(true);
    try {
      const data = await fetchPage("/api/favorites", { limit: String(PAGE_SIZE), offset: String(offset) });
      setFavGames(reset ? data.games : [...current, ...data.games]);
      setFavTotal(data.total);
    } finally {
      setFavLoading(false);
    }
  }, [favLoading, fetchPage]);

  const loadRecent = useCallback(async (reset: boolean, current: Game[], total: number) => {
    if (recentLoading) return;
    const offset = reset ? 0 : current.length;
    if (!reset && offset >= total && total > 0) return;
    setRecentLoading(true);
    try {
      const data = await fetchPage("/api/recent-plays", { limit: String(PAGE_SIZE), offset: String(offset) });
      setRecentGames(reset ? data.games : [...current, ...data.games]);
      setRecentTotal(data.total);
    } finally {
      setRecentLoading(false);
    }
  }, [recentLoading, fetchPage]);

  useEffect(() => {
    if (!hasServers) return;
    loadAllGames(true, search, [], 0);
  }, [search, hasServers]);

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

  const navigateToGame = useCallback(async (gameId: string, serverId: string, lanPlayerUrls?: string[] | null) => {
    const hostToken = crypto.randomUUID();
    const resp = await fetch("/api/room/shorten", {
      method: "POST",
      headers: csrfHeaders(),
      body: JSON.stringify({ game_id: gameId, host_token: hostToken, server_id: serverId }),
    });
    if (!resp.ok) throw new Error("shorten failed");
    const data = await resp.json();
    const code = data.code as string;
    const lanUrl = buildLanPlayerLaunchUrl({ playerUrls: lanPlayerUrls, gameId, serverId, code, hostToken });
    if (lanUrl) {
      // Record the launch route before navigating
      fetch("/api/launch-event", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          event: "launch_route_chosen",
          game_id: gameId,
          server_id: serverId,
          detail: {
            route: "lan_direct",
            lan_url: lanUrl,
            player_urls: lanPlayerUrls,
          },
        }),
      }).catch(() => {});
      window.location.assign(lanUrl);
      return;
    }
    // Relay fallback — no LAN player reachable
    fetch("/api/launch-event", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        event: "launch_route_chosen",
        game_id: gameId,
        server_id: serverId,
        detail: {
          route: "relay",
          reason: "lan_unreachable",
        },
      }),
    }).catch(() => {});
    router.push(`/p/${code}`);
  }, [router]);

  async function probePlayableHosts(hosts: PlayableHost[]) {
    const entries = await Promise.all(
      hosts.map(async (host) => {
        const result = await probeLanHealth(host.lan?.health_urls, { timeoutMs: 1_200 });
        return [host.server_id, result] as const;
      }),
    );
    setLanProbeByServer(Object.fromEntries(entries));
  }

  function canAttemptLanLaunch(probe: LanProbeResult | undefined): boolean {
    return probe?.reachable === true;
  }

  function lanPlayerUrlsWhenDirectOrPolicyBlocked(host: PlayableHost): string[] | null {
    const probe = lanProbeByServer[host.server_id];
    return canAttemptLanLaunch(probe) ? host.lan?.player_urls ?? null : null;
  }

  const handlePlay = async (gameId: string) => {
    if (!hasServers) return;
    recordRecentPlay(gameId);
    try {
      const resp = await fetch(`/api/playable-hosts?game_id=${encodeURIComponent(gameId)}`);
      if (!resp.ok) throw new Error("failed");
      const data = await resp.json();
      const hosts: PlayableHost[] = data.hosts || [];
      setPlayableHosts(hosts);
      setLanProbeByServer({});

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

      if (withGame.length === 0) { setHostPickerGame(gameId); void probePlayableHosts(hosts); return; }
      if (withGame.length === 1) {
        const host = withGame[0];
        const serverId = host.server_id;
        setPreferredServer(gameId, serverId);
        const probe = await probeLanHealth(host.lan?.health_urls, { timeoutMs: 1_200 });
        await navigateToGame(gameId, serverId, canAttemptLanLaunch(probe) ? host.lan?.player_urls : null);
        return;
      }
      setHostPickerGame(gameId);
      void probePlayableHosts(hosts);
    } catch { /* silent */ }
  };

  const selectHost = async (gameId: string, serverId: string, _serverName: string) => {
    const host = playableHosts.find((h) => h.server_id === serverId);
    setHostPickerGame(null);
    setPreferredServer(gameId, serverId);
    try { await navigateToGame(gameId, serverId, host ? lanPlayerUrlsWhenDirectOrPolicyBlocked(host) : null); } catch { /* silent */ }
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
      const update = (list: Game[]) => list.map((g) => g.id === gameId ? { ...g, name: trimmed } : g);
      setAllGames(update);
      setFavGames(update);
      setRecentGames(update);
      cancelRename();
    } catch { setEditSaving(false); }
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
      if (newState) next.add(gameId); else next.delete(gameId);
      return next;
    });
    if (!newState && tab === "favorites") {
      setFavGames((prev) => prev.filter((g) => g.id !== gameId));
      setFavTotal((prev) => prev - 1);
    }
  }, [tab]);

  // ── Pin toggle ──────────────────────────────────────────────────

  const handleTogglePin = useCallback(async (gameId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const result = await togglePin(gameId);
    setPinnedIds((prev) => {
      const next = new Set(prev);
      if (result.pinned) next.add(gameId); else next.delete(gameId);
      return next;
    });
  }, []);

  // ── Current tab's game list ─────────────────────────────────────

  const currentGames = tab === "all" ? allGames : tab === "favorites" ? favGames : recentGames;
  const currentTotal = tab === "all" ? allTotal : tab === "favorites" ? favTotal : recentTotal;
  const currentLoading = tab === "all" ? allLoading : tab === "favorites" ? favLoading : recentLoading;
  const hasMore = currentGames.length < currentTotal;

  const uniquePlatforms = [...new Set(allGames.map((g) => g.platform))].sort();
  const platformCounts = useMemo(() => {
    const m: Record<string, number> = {};
    for (const g of allGames) m[g.platform] = (m[g.platform] || 0) + 1;
    return m;
  }, [allGames]);

  // Apply platform filter
  const filteredGames = selectedPlatforms.size === 0
    ? currentGames
    : currentGames.filter((g) => selectedPlatforms.has(g.platform));

  // Sort: pinned first
  const sortedGames = useMemo(() => {
    if (pinnedIds.size === 0 || tab !== "all") return filteredGames;
    const pinned: Game[] = [];
    const unpinned: Game[] = [];
    for (const g of filteredGames) {
      if (pinnedIds.has(g.id)) pinned.push(g);
      else unpinned.push(g);
    }
    return [...pinned, ...unpinned];
  }, [filteredGames, pinnedIds, tab]);

  const pinnedCount = sortedGames.filter((g) => pinnedIds.has(g.id)).length;

  // ── Render helpers ──────────────────────────────────────────────

  const gameActions: GameActionModel = {
    canFavorite: Boolean(session?.user?.id),
    canPin: Boolean(session?.user?.id),
    canRename: Boolean(session?.user?.id),
    isFavorite: (gameId: string) => favoriteIds.has(gameId),
    isPinned: (gameId: string) => pinnedIds.has(gameId),
    onPlay: handlePlay,
    onToggleFavorite: session?.user?.id ? handleToggleFavorite : undefined,
    onTogglePin: session?.user?.id ? handleTogglePin : undefined,
    onRename: session?.user?.id ? startRename : undefined,
  };

  function renderLanRouteBadge(host: PlayableHost) {
    if (!host.lan?.health_urls?.length) return null;
    const probe = lanProbeByServer[host.server_id];
    if (!probe) return <Badge variant="muted">LAN probing…</Badge>;
    if (probe.reachable) {
      return <Badge variant="success">LAN direct {probe.latencyMs.toFixed(0)}ms</Badge>;
    }
    if (probe.reason === "mixed_content_blocked") {
      return <Badge variant="warning">HTTPS probe blocked · click tries LAN</Badge>;
    }
    return <Badge variant="warning">Relay fallback</Badge>;
  }

  const renderStatePills = (game: Game) => (
    <div style={styles.statePillRow}>
      <span style={styles.statePill}>{game.platform}</span>
      <span style={styles.statePill}>{game.maxPlayers > 1 ? `${game.maxPlayers}p` : "1p"}</span>
      {gameActions.isPinned(game.id) && <span style={{ ...styles.statePill, ...styles.statePillAccent }}>Pinned</span>}
      {gameActions.isFavorite(game.id) && <span style={{ ...styles.statePill, ...styles.statePillAccent }}>Favorite</span>}
    </div>
  );

  const renderGameCard = (game: Game) => (
    <GameTile
      key={game.id}
      game={game}
      size="square"
      isFavorite={gameActions.isFavorite(game.id)}
      isPinned={gameActions.isPinned(game.id)}
      onPlay={gameActions.onPlay}
      onToggleFavorite={gameActions.onToggleFavorite}
      onTogglePin={gameActions.onTogglePin}
      onEdit={gameActions.onRename}
    />
  );

  const renderGameRow = (game: Game, index: number) => (
    <tr
      key={game.id}
      onClick={() => handlePlay(game.id)}
      style={{
        cursor: "pointer",
        background: index % 2 === 0 ? "rgba(17,24,39,0.3)" : "transparent",
        transition: "background 0.1s",
      }}
      onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = "rgba(56,189,248,0.08)"; }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLElement).style.background = index % 2 === 0 ? "rgba(17,24,39,0.3)" : "transparent";
      }}
    >
      <td style={{ padding: "12px 14px", fontSize: "var(--font-size-md)", color: "var(--color-cloud)" }}>
        <div style={styles.tableNameCell}>
          <span style={styles.tableName}>{game.name}</span>
          {renderStatePills(game)}
        </div>
      </td>
      <td style={{ padding: "12px 14px" }}>
        <Badge variant="info">{game.platform}</Badge>
      </td>
      <td style={{ padding: "12px 14px", textAlign: "center", fontSize: "var(--font-size-xs)", color: "var(--color-cloud-dim)" }}>
        {game.maxPlayers > 1 ? `${game.maxPlayers}p` : "1p"}
      </td>
      <td style={{ padding: "10px 14px", textAlign: "center" }}>
        {gameActions.canFavorite && gameActions.onToggleFavorite && (
          <button
            onClick={(e) => gameActions.onToggleFavorite?.(game.id, e)}
            style={{ background: "none", border: "none", cursor: "pointer", color: gameActions.isFavorite(game.id) ? "#38bdf8" : "#4b5563" }}
            title={gameActions.isFavorite(game.id) ? "Remove favorite" : "Add favorite"}
          >
            {gameActions.isFavorite(game.id) ? "★" : "☆"}
          </button>
        )}
      </td>
      <td style={{ padding: "10px 14px", textAlign: "center" }}>
        {gameActions.canPin && gameActions.onTogglePin && (
          <button
            onClick={(e) => gameActions.onTogglePin?.(game.id, e)}
            style={{
              background: "none",
              border: "none",
              cursor: "pointer",
              color: gameActions.isPinned(game.id) ? "#38bdf8" : "#4b5563",
              fontSize: 14,
            }}
            title={gameActions.isPinned(game.id) ? "Unpin" : `Pin (max ${MAX_PINS})`}
          >
            {gameActions.isPinned(game.id) ? "📌" : "📍"}
          </button>
        )}
      </td>
      <td style={{ padding: "10px 14px", textAlign: "center" }}>
        {gameActions.canRename && gameActions.onRename && (
          <Button
            variant="secondary"
            size="sm"
            onClick={(e) => {
              e.stopPropagation();
              gameActions.onRename?.(game);
            }}
          >
            Rename
          </Button>
        )}
      </td>
      <td style={{ padding: "10px 14px", textAlign: "right" }}>
        <Button variant="primary" size="sm" onClick={(e) => { e.stopPropagation(); gameActions.onPlay(game.id); }}>
          Play
        </Button>
      </td>
    </tr>
  );

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
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "var(--space-4)" }}>
          <h2 style={styles.h2}>Library</h2>

          {/* View toggle */}
          <div style={{ display: "flex", gap: 4, background: "var(--color-sky-mid)", borderRadius: 2, padding: 2 }}>
            <button
              onClick={() => setViewMode("grid")}
              style={{
                padding: "6px 14px",
                background: viewMode === "grid" ? "var(--color-sky-high)" : "transparent",
                border: "none",
                borderRadius: 2,
                color: viewMode === "grid" ? "var(--color-accent)" : "var(--color-cloud-dim)",
                fontSize: "var(--font-size-xs)",
                fontFamily: "var(--font-mono)",
                cursor: "pointer",
                textTransform: "uppercase",
                letterSpacing: "0.05em",
              }}
            >
              ▦ Grid
            </button>
            <button
              onClick={() => setViewMode("table")}
              style={{
                padding: "6px 14px",
                background: viewMode === "table" ? "var(--color-sky-high)" : "transparent",
                border: "none",
                borderRadius: 2,
                color: viewMode === "table" ? "var(--color-accent)" : "var(--color-cloud-dim)",
                fontSize: "var(--font-size-xs)",
                fontFamily: "var(--font-mono)",
                cursor: "pointer",
                textTransform: "uppercase",
                letterSpacing: "0.05em",
              }}
            >
              ☰ Table
            </button>
          </div>
        </div>

        {/* Tabs */}
        <div style={{ display: "flex", gap: 0, marginBottom: "var(--space-4)" }}>
          {(["all", "favorites", "recent"] as const).map((t) => {
            const isActive = tab === t;
            const counts: Record<string, number> = { all: allTotal, favorites: favTotal, recent: recentTotal };
            return (
              <button
                key={t}
                onClick={() => { setTab(t); setSelectedPlatforms(new Set()); }}
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
                {counts[t] > 0 ? ` (${counts[t]})` : ""}
              </button>
            );
          })}
        </div>

        {/* Search + Filter row */}
        {tab === "all" && (
          <div style={{ display: "flex", gap: "var(--space-4)", marginBottom: "var(--space-5)", alignItems: "center", flexWrap: "wrap" }}>
            <input
              type="text"
              placeholder="Search games..."
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              style={{
                width: 280,
                padding: "10px 14px",
                background: "var(--color-sky-high)",
                border: "2px solid var(--color-sky-high)",
                borderRadius: "var(--radius-sm)",
                color: "var(--color-cloud)",
                fontSize: "var(--font-size-base)",
                fontFamily: "var(--font-mono)",
                outline: "none",
                transition: "border-color 0.15s",
              }}
              onFocus={(e) => { e.target.style.borderColor = "var(--color-accent)"; }}
              onBlur={(e) => { e.target.style.borderColor = "var(--color-sky-high)"; }}
            />

            {/* Platform dropdown filter */}
            <div ref={filterRef} style={{ position: "relative" }}>
              <button
                onClick={() => setPlatformDropdownOpen((v) => !v)}
                style={{
                  padding: "10px 14px",
                  background: selectedPlatforms.size > 0 ? "rgba(56,189,248,0.12)" : "var(--color-sky-high)",
                  border: selectedPlatforms.size > 0 ? "1px solid rgba(56,189,248,0.3)" : "1px solid var(--color-sky-high)",
                  borderRadius: 2,
                  color: selectedPlatforms.size > 0 ? "var(--color-accent)" : "var(--color-cloud-dim)",
                  fontSize: "var(--font-size-sm)",
                  fontFamily: "var(--font-mono)",
                  cursor: "pointer",
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  transition: "all 0.15s",
                }}
              >
                <span>{selectedPlatforms.size > 0 ? `Systems (${selectedPlatforms.size})` : "All Systems"}</span>
                <span style={{ fontSize: 10 }}>{platformDropdownOpen ? "▲" : "▼"}</span>
              </button>

              {platformDropdownOpen && (
                <div style={{
                  position: "absolute",
                  top: "100%",
                  left: 0,
                  marginTop: 4,
                  background: "var(--color-sky-mid)",
                  border: "1px solid var(--color-sky-high)",
                  borderRadius: 2,
                  zIndex: 50,
                  minWidth: 220,
                  maxHeight: 360,
                  overflowY: "auto",
                  boxShadow: "0 8px 24px rgba(0,0,0,0.4)",
                }}>
                  <button
                    onClick={() => { setSelectedPlatforms(new Set()); setPlatformDropdownOpen(false); }}
                    style={{
                      display: "block",
                      width: "100%",
                      padding: "8px 14px",
                      background: selectedPlatforms.size === 0 ? "var(--color-sky-high)" : "transparent",
                      border: "none",
                      color: selectedPlatforms.size === 0 ? "var(--color-accent)" : "var(--color-cloud-dim)",
                      fontSize: "var(--font-size-sm)",
                      fontFamily: "var(--font-mono)",
                      cursor: "pointer",
                      textAlign: "left",
                    }}
                  >
                    All Systems ({allTotal})
                  </button>
                  {uniquePlatforms.map((platform) => {
                    const checked = selectedPlatforms.has(platform);
                    return (
                      <label
                        key={platform}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 8,
                          padding: "8px 14px",
                          background: checked ? "var(--color-sky-high)" : "transparent",
                          cursor: "pointer",
                          fontSize: "var(--font-size-sm)",
                          fontFamily: "var(--font-mono)",
                          color: checked ? "var(--color-accent)" : "var(--color-cloud-dim)",
                        }}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => {
                            setSelectedPlatforms((prev) => {
                              const next = new Set(prev);
                              if (next.has(platform)) next.delete(platform);
                              else next.add(platform);
                              return next;
                            });
                          }}
                          style={{ accentColor: "var(--color-accent)" }}
                        />
                        {platform}
                        <span style={{ marginLeft: "auto", fontSize: "var(--font-size-xs)", opacity: 0.5 }}>
                          ({platformCounts[platform] || 0})
                        </span>
                      </label>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Pin count */}
            {pinnedCount > 0 && (
              <span style={{ fontSize: "var(--font-size-xs)", color: "var(--color-accent)", fontFamily: "var(--font-mono)" }}>
                📌 {pinnedCount} pinned
              </span>
            )}
          </div>
        )}

        {/* Game grid / table */}
        {sortedGames.length === 0 && !currentLoading ? (
          <p style={styles.empty}>
            {selectedPlatforms.size > 0
              ? "No games match the selected platforms."
              : tab === "all" ? "No games found." : tab === "favorites" ? "No favorites yet." : "No recent plays."}
          </p>
        ) : viewMode === "grid" ? (
          <div style={styles.librarySurfaceCard}>
            <div style={styles.librarySurfaceHeader}>
              <span style={styles.librarySurfaceTitle}>Tile view</span>
              <span style={styles.librarySurfaceHint}>Metro tiles with the same play, favorite, pin, and rename actions.</span>
            </div>
            <div className="game-tile-grid">
              {sortedGames.map((game) => renderGameCard(game))}
            </div>
          </div>
        ) : (
          <div style={styles.librarySurfaceCard}>
            <div style={styles.librarySurfaceHeader}>
              <span style={styles.librarySurfaceTitle}>Table view</span>
              <span style={styles.librarySurfaceHint}>Dense library scan with the same state and actions as tiles.</span>
            </div>
          <div style={{ overflowX: "auto" }}>
            <table style={{
              width: "100%",
              borderCollapse: "collapse",
              fontSize: "var(--font-size-sm)",
              fontFamily: "var(--font-mono)",
            }}>
              <thead>
                <tr style={{
                  borderBottom: "2px solid var(--color-sky-high)",
                  color: "var(--color-cloud-dim)",
                  fontSize: "var(--font-size-xs)",
                  textTransform: "uppercase",
                  letterSpacing: "0.06em",
                }}>
                  <th style={{ textAlign: "left", padding: "10px 14px", fontWeight: 600 }}>Name</th>
                  <th style={{ textAlign: "left", padding: "10px 14px", fontWeight: 600 }}>Platform</th>
                  <th style={{ textAlign: "center", padding: "10px 14px", fontWeight: 600 }}>Players</th>
                  <th style={{ textAlign: "center", padding: "10px 14px", fontWeight: 600 }}>Fav</th>
                  <th style={{ textAlign: "center", padding: "10px 14px", fontWeight: 600 }}>Pin</th>
                  <th style={{ textAlign: "center", padding: "10px 14px", fontWeight: 600 }}>Rename</th>
                  <th style={{ textAlign: "right", padding: "10px 14px", fontWeight: 600 }}>Play</th>
                </tr>
              </thead>
              <tbody>
                {sortedGames.map((game, i) => renderGameRow(game, i))}
              </tbody>
            </table>
          </div>
          </div>
        )}

        {currentLoading && (
          <div style={styles.loading}>Loading...</div>
        )}

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
                {renderLanRouteBadge(host)}
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
            <Button variant="secondary" onClick={cancelRename}>Cancel</Button>
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
  librarySurfaceCard: {
    border: "1px solid rgba(56, 189, 248, 0.12)",
    background: "rgba(17, 24, 39, 0.7)",
    padding: "var(--space-5)",
    boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.02)",
  },
  librarySurfaceHeader: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    gap: "var(--space-4)",
    marginBottom: "var(--space-5)",
    flexWrap: "wrap",
  },
  librarySurfaceTitle: {
    color: "var(--color-accent)",
    fontFamily: "var(--font-mono)",
    fontSize: "var(--font-size-sm)",
    textTransform: "uppercase",
    letterSpacing: "0.08em",
  },
  librarySurfaceHint: {
    color: "var(--color-cloud-dim)",
    fontSize: "var(--font-size-sm)",
  },
  h2: {
    margin: 0,
    fontSize: "var(--font-size-lg)",
    fontWeight: 600,
    color: "var(--color-accent)",
    fontFamily: "var(--font-mono)",
    textTransform: "uppercase",
    letterSpacing: "0.05em",
  },
  empty: { fontSize: "var(--font-size-base)", color: "var(--color-cloud-dim)", fontStyle: "italic" },
  tableNameCell: {
    display: "flex",
    flexDirection: "column",
    gap: "var(--space-2)",
  },
  tableName: {
    fontWeight: 600,
    color: "var(--color-cloud)",
    fontSize: "var(--font-size-md)",
  },
  statePillRow: {
    display: "flex",
    flexWrap: "wrap",
    gap: "var(--space-2)",
  },
  statePill: {
    display: "inline-flex",
    alignItems: "center",
    padding: "2px 6px",
    border: "1px solid rgba(255,255,255,0.12)",
    background: "rgba(10,14,26,0.5)",
    color: "var(--color-cloud-dim)",
    fontFamily: "var(--font-mono)",
    fontSize: "var(--font-size-xs)",
    textTransform: "uppercase",
    letterSpacing: "0.05em",
  },
  statePillAccent: {
    color: "var(--color-accent)",
    border: "1px solid rgba(56,189,248,0.24)",
    background: "rgba(56,189,248,0.12)",
  },
  loading: {
    textAlign: "center" as const,
    padding: "var(--space-8)",
    color: "var(--color-cloud-dim)",
    fontSize: "var(--font-size-base)",
  },
  sentinel: { height: "1px" },
  pickerRow: {
    display: "flex", alignItems: "center", gap: "var(--space-4)",
    padding: "var(--space-4) 0", borderBottom: "1px solid var(--color-sky-high)",
  },
  pickerName: { flex: 1, fontSize: "var(--font-size-md)", color: "var(--color-cloud)", fontFamily: "var(--font-mono)" },
};
