"use client";

import { useState, useCallback, useEffect, useRef, useMemo } from "react";
import { useRouter } from "next/navigation";
import { Badge, Button, Modal } from "@/components/ui";
import GameTile from "@/components/fluent/GameTile";
import AppHeader from "@/components/fluent/AppHeader";
import LibraryToolbar from "@/components/LibraryToolbar";
import { Star20Filled, Star20Regular, Pin20Filled, Pin20Regular, Edit20Regular, Desktop20Regular } from "@fluentui/react-icons";
import { buildLanPlayerLaunchUrl, canUseLanPlayer, chooseLaunchHost, createLaunchRequestGate, formatLaunchError } from "@/lib/lan/launch";
import { probeLanHealth, type LanProbeResult } from "@/lib/lan/probe";
import { createAllLibraryPageParams, createLatestRequestGate, createLibraryFilters, createLibraryPageParams, filterLibraryGames, formatRecentGroupLabel, formatRelativeAge, groupRecentGamesByLocalDate, mergeLibraryPages, mergeRecentLibraryPages, type LibraryGame, type LibrarySection } from "@/lib/ui/library-view-model";

// ── Types ─────────────────────────────────────────────────────────────

interface Game {
  id: string;
  name: string;
  platform: string;
  maxPlayers: number;
  playedAt?: string;
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
  onChooseHost?: (gameId: string) => void;
}

interface PlayableHost {
  server_id: string;
  name: string;
  status: string;
  has_game: boolean;
  capabilities: {
    lan: boolean;
    stun: boolean;
    turn: boolean;
  };
  lan?: {
    player_port?: number;
    player_urls?: string[];
    health_urls?: string[];
  } | null;
  role?: string;
  metadata?: Record<string, unknown>;
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
    .find((c) => c.startsWith(`sc_host_${gameId}=`));
  if (!match) return null;
  return decodeURIComponent(match.split("=").slice(1).join("="));
}

function setPreferredServer(gameId: string, serverId: string) {
  if (typeof document === "undefined") return;
  document.cookie = `sc_host_${gameId}=${encodeURIComponent(serverId)}; Path=/; Max-Age=${365 * 24 * 3600}; SameSite=Lax`;
}

function statusVariant(status: string) {
  const map: Record<string, "success" | "warning" | "error"> = {
    online: "success", stale: "warning", offline: "error",
  };
  return map[status] || "error";
}

function csrfHeaders(): Record<string, string> {
  let token = document.cookie
    .split(";")
    .map((p) => p.trim())
    .find((p) => p.startsWith("sc_csrf_token="))
    ?.split("=")
    .slice(1)
    .join("=");
  if (!token) {
    token = crypto.randomUUID();
    document.cookie = `sc_csrf_token=${encodeURIComponent(token)}; Path=/; SameSite=Lax`;
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

async function fetchPinnedGames(): Promise<Game[]> {
  try {
    const resp = await fetch("/api/pins");
    if (!resp.ok) return [];
    const data = await resp.json();
    return (data.games || []).slice(0, MAX_PINS);
  } catch {
    return [];
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
  const [rememberSelectedHost, setRememberSelectedHost] = useState(false);
  const [hostPickerLoading, setHostPickerLoading] = useState(false);
  const [launchingGame, setLaunchingGame] = useState<string | null>(null);
  const [launchError, setLaunchError] = useState<string | null>(null);
  const launchGate = useRef(createLaunchRequestGate());
  const launchAbort = useRef<AbortController | null>(null);

  const [editingGame, setEditingGame] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editSaving, setEditSaving] = useState(false);

  const [tab, setTab] = useState<LibrarySection>("all");
  const [search, setSearch] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const searchTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // Platform filter: empty = show all
  const [selectedPlatforms, setSelectedPlatforms] = useState<Set<string>>(new Set());

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
  const favoritesRequests = useRef(createLatestRequestGate());
  const recentRequests = useRef(createLatestRequestGate());

  const [favoriteIds, setFavoriteIds] = useState<Set<string>>(new Set());
  const [pinnedIds, setPinnedIds] = useState<Set<string>>(new Set());
  const [pinnedGames, setPinnedGames] = useState<Game[]>([]);
  const [pinsLoading, setPinsLoading] = useState(false);

  const sentinelRef = useRef<HTMLDivElement>(null);
  const hasServers = serverIds.length > 0;

  // Load favorites and the complete (max 20) pinned rows on mount.
  useEffect(() => {
    if (!session?.user?.id) {
      setPinnedGames([]);
      setPinnedIds(new Set());
      return;
    }
    fetchFavoriteIds().then(setFavoriteIds);
    setPinsLoading(true);
    fetchPinnedGames().then((games) => {
      setPinnedGames(games);
      setPinnedIds(new Set(games.map((game) => game.id)));
    }).finally(() => setPinsLoading(false));
  }, [session?.user?.id]);


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
      const data = await fetchPage("/api/games", createAllLibraryPageParams(PAGE_SIZE, offset, searchTerm));
      setAllGames(reset ? data.games : mergeLibraryPages(current, data.games));
      setAllTotal(data.total);
    } finally {
      setAllLoading(false);
    }
  }, [allLoading, fetchPage]);

  const loadFavorites = useCallback(async (reset: boolean, searchTerm: string, current: Game[], total: number) => {
    if (favLoading && !reset) return;
    const offset = reset ? 0 : current.length;
    if (!reset && offset >= total && total > 0) return;
    const generation = reset ? favoritesRequests.current.beginReset() : favoritesRequests.current.current();
    setFavLoading(true);
    try {
      const data = await fetchPage("/api/favorites", createLibraryPageParams(PAGE_SIZE, offset, searchTerm));
      if (!favoritesRequests.current.isCurrent(generation)) return;
      setFavGames(reset ? data.games : [...current, ...data.games]);
      setFavTotal(data.total);
    } finally {
      if (favoritesRequests.current.isCurrent(generation)) setFavLoading(false);
    }
  }, [favLoading, fetchPage]);

  const loadRecent = useCallback(async (reset: boolean, searchTerm: string, current: Game[], total: number) => {
    if (recentLoading && !reset) return;
    const offset = reset ? 0 : current.length;
    if (!reset && offset >= total && total > 0) return;
    const generation = reset ? recentRequests.current.beginReset() : recentRequests.current.current();
    setRecentLoading(true);
    try {
      const data = await fetchPage("/api/recent-plays", createLibraryPageParams(PAGE_SIZE, offset, searchTerm));
      if (!recentRequests.current.isCurrent(generation)) return;
      setRecentGames(reset ? mergeRecentLibraryPages([], data.games) : mergeRecentLibraryPages(current, data.games));
      setRecentTotal(data.total);
    } finally {
      if (recentRequests.current.isCurrent(generation)) setRecentLoading(false);
    }
  }, [recentLoading, fetchPage]);

  useEffect(() => {
    if (!hasServers) return;
    loadAllGames(true, search, [], 0);
  }, [search, hasServers]);

  useEffect(() => {
    if (!hasServers || !session?.user?.id) return;
    if (tab === "favorites") loadFavorites(true, search, [], 0);
    if (tab === "recent") loadRecent(true, search, [], 0);
  }, [tab, search, hasServers, session?.user?.id]);

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
            loadFavorites(false, search, favGames, favTotal);
          } else if (tab === "recent" && recentGames.length < recentTotal) {
            loadRecent(false, search, recentGames, recentTotal);
          }
        }
      },
      { threshold: 0.1 },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [tab, allGames.length, allTotal, favGames.length, favTotal, recentGames.length, recentTotal, search]);

  // ── Play handler ─────────────────────────────────────────────────

  async function responseError(response: Response, fallback: string): Promise<Error> {
    let detail = "";
    try {
      const body = await response.json() as { error?: unknown; message?: unknown };
      const candidate = typeof body.error === "string" ? body.error : typeof body.message === "string" ? body.message : "";
      detail = candidate.trim();
    } catch (error) {
      console.warn("Could not parse launch error response", error);
    }
    return new Error(detail || `${fallback} (HTTP ${response.status})`);
  }

  const closeHostPicker = useCallback(() => {
    launchAbort.current?.abort();
    launchAbort.current = null;
    launchGate.current.invalidate();
    setHostPickerGame(null);
    setPlayableHosts([]);
    setLanProbeByServer({});
    setHostPickerLoading(false);
    setLaunchError(null);
    setRememberSelectedHost(false);
  }, []);

  const openHostPicker = useCallback((gameId: string, visible = true) => {
    launchAbort.current?.abort();
    launchAbort.current = new AbortController();
    const generation = launchGate.current.beginRequest();
    setHostPickerGame(visible ? gameId : null);
    setPlayableHosts([]);
    setLanProbeByServer({});
    setRememberSelectedHost(false);
    setLaunchError(null);
    setHostPickerLoading(true);
    return generation;
  }, []);

  const navigateToGame = useCallback(async (gameId: string, serverId: string, generation: number, lanPlayerUrls?: string[] | null) => {
    const hostToken = crypto.randomUUID();
    const resp = await fetch("/api/room/shorten", {
      method: "POST",
      headers: csrfHeaders(),
      body: JSON.stringify({ game_id: gameId, host_token: hostToken, server_id: serverId }),
      signal: launchAbort.current?.signal,
    });
    if (!resp.ok) throw await responseError(resp, "Could not create a play link");
    const data = await resp.json() as { code?: unknown };
    if (typeof data.code !== "string" || !data.code.trim()) throw new Error("The play link response did not include a code");
    if (!launchGate.current.isCurrent(generation)) return;
    const code = data.code;
    const lanUrl = buildLanPlayerLaunchUrl({ playerUrls: lanPlayerUrls, gameId, serverId, code, hostToken });
    const detail = lanUrl
      ? { route: "lan_direct", lan_url: lanUrl, player_urls: lanPlayerUrls }
      : { route: "relay", reason: "lan_unreachable" };
    void fetch("/api/launch-event", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ event: "launch_route_chosen", game_id: gameId, server_id: serverId, detail }),
    }).catch((error) => console.warn("Could not record launch route", error));
    if (lanUrl) window.location.assign(lanUrl);
    else router.push(`/p/${code}`);
  }, [router]);

  async function probePlayableHosts(hosts: PlayableHost[], generation: number) {
    try {
      const entries = await Promise.all(hosts.map(async (host) => {
        if (!host.capabilities.lan) return [host.server_id, { reachable: false, reason: "no_urls" } as LanProbeResult] as const;
        return [host.server_id, await probeLanHealth(host.lan?.health_urls, { timeoutMs: 1_200 })] as const;
      }));
      if (launchGate.current.isCurrent(generation)) setLanProbeByServer(Object.fromEntries(entries));
    } catch (error) {
      if (launchGate.current.isCurrent(generation)) setLaunchError(formatLaunchError(error, "Could not check host connections. You can retry."));
    }
  }

  function canAttemptLanLaunch(probe: LanProbeResult | undefined, host: PlayableHost): boolean {
    return host.capabilities.lan && probe ? canUseLanPlayer(probe) : false;
  }

  function lanPlayerUrlsWhenDirectOrPolicyBlocked(host: PlayableHost): string[] | null {
    const probe = lanProbeByServer[host.server_id];
    return canAttemptLanLaunch(probe, host) ? host.lan?.player_urls ?? null : null;
  }

  const loadHosts = async (gameId: string, automatic: boolean) => {
    if (!hasServers || !launchGate.current.tryBeginLaunch()) return;
    const generation = openHostPicker(gameId, !automatic);
    setLaunchingGame(gameId);
    try {
      const resp = await fetch(`/api/playable-hosts?game_id=${encodeURIComponent(gameId)}`, { signal: launchAbort.current?.signal });
      if (!resp.ok) throw await responseError(resp, "Could not load hosts");
      const data = await resp.json() as { hosts?: PlayableHost[] };
      if (!launchGate.current.isCurrent(generation)) return;
      const hosts = Array.isArray(data.hosts) ? data.hosts : [];
      setPlayableHosts(hosts);
      setHostPickerLoading(false);

      const host = automatic ? chooseLaunchHost(hosts, getPreferredServer(gameId)) : null;
      if (host) {
        const probe = host.capabilities.lan
          ? await probeLanHealth(host.lan?.health_urls, { timeoutMs: 1_200 })
          : { reachable: false, reason: "no_urls" } as LanProbeResult;
        if (!launchGate.current.isCurrent(generation)) return;
        await navigateToGame(gameId, host.server_id, generation, canAttemptLanLaunch(probe, host) ? host.lan?.player_urls : null);
        if (launchGate.current.isCurrent(generation)) closeHostPicker();
        return;
      }
      setHostPickerGame(gameId);
      await probePlayableHosts(hosts, generation);
    } catch (error) {
      if (launchGate.current.isCurrent(generation)) {
        setHostPickerGame(gameId);
        setHostPickerLoading(false);
        setLaunchError(formatLaunchError(error, "Could not start the game. Please retry."));
      }
    } finally {
      launchGate.current.finishLaunch();
      setLaunchingGame(null);
    }
  };

  const handlePlay = (gameId: string) => {
    recordRecentPlay(gameId);
    void loadHosts(gameId, true);
  };

  const chooseHost = (gameId: string) => void loadHosts(gameId, false);

  const selectHost = async (gameId: string, serverId: string, _serverName: string) => {
    if (!launchGate.current.tryBeginLaunch()) return;
    const generation = launchGate.current.beginRequest();
    const host = playableHosts.find((candidate) => candidate.server_id === serverId);
    setLaunchingGame(gameId);
    setLaunchError(null);
    try {
      await navigateToGame(gameId, serverId, generation, host ? lanPlayerUrlsWhenDirectOrPolicyBlocked(host) : null);
      if (!launchGate.current.isCurrent(generation)) return;
      if (rememberSelectedHost) setPreferredServer(gameId, serverId);
      closeHostPicker();
    } catch (error) {
      setLaunchError(formatLaunchError(error, "Could not start the game. Please retry."));
    } finally {
      launchGate.current.finishLaunch();
      setLaunchingGame(null);
    }
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
      setPinnedGames(update);
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
    await togglePin(gameId);
    setPinsLoading(true);
    try {
      const games = await fetchPinnedGames();
      setPinnedGames(games);
      setPinnedIds(new Set(games.map((game) => game.id)));
    } finally {
      setPinsLoading(false);
    }
  }, []);

  // ── Current tab's game list ─────────────────────────────────────

  const currentGames = tab === "all" ? allGames : tab === "pins" ? pinnedGames : tab === "favorites" ? favGames : recentGames;
  const currentTotal = tab === "all" ? allTotal : tab === "pins" ? pinnedGames.length : tab === "favorites" ? favTotal : recentTotal;
  const currentLoading = tab === "all" ? allLoading : tab === "pins" ? pinsLoading : tab === "favorites" ? favLoading : recentLoading;
  const hasMore = tab !== "pins" && currentGames.length < currentTotal;

  const platformSource = mergeLibraryPages(allGames, pinnedGames);
  const uniquePlatforms = [...new Set(platformSource.map((g) => g.platform))].sort();
  const platformCounts = useMemo(() => {
    const m: Record<string, number> = {};
    for (const g of platformSource) m[g.platform] = (m[g.platform] || 0) + 1;
    return m;
  }, [allGames, pinnedGames]);

  const sortedGames = useMemo(() => {
    const normalized: LibraryGame[] = currentGames.map((game, index) => ({
      ...game,
      favorite: tab === "favorites" || favoriteIds.has(game.id),
      pinned: pinnedIds.has(game.id),
      recentRank: tab === "recent" ? index : null,
      serverId: null,
      coverUrl: null,
    }));
    const filtered = filterLibraryGames(normalized, createLibraryFilters(tab, search, selectedPlatforms));
    const byId = new Map(currentGames.map((game) => [game.id, game]));
    return filtered.map((game) => byId.get(game.id)!);
  }, [currentGames, favoriteIds, pinnedIds, search, selectedPlatforms, tab]);
  const recentGroups = useMemo(
    () => tab === "recent"
      ? groupRecentGamesByLocalDate(sortedGames)
      : [],
    [sortedGames, tab],
  );

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
    onChooseHost: hasServers ? chooseHost : undefined,
  };


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
      onChooseHost={gameActions.onChooseHost}
      launching={launchingGame === game.id}
    />
  );

  const renderGameRow = (game: Game, index: number) => (
    <tr
      key={game.id}
      className="library-game-row"
      style={{
        background: index % 2 === 0 ? "rgba(17,24,39,0.3)" : "transparent",
        transition: "background 0.1s",
      }}
      onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = "rgba(56,189,248,0.08)"; }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLElement).style.background = index % 2 === 0 ? "rgba(17,24,39,0.3)" : "transparent";
      }}
    >
      <td style={{ padding: "12px 14px", fontSize: "var(--font-size-md)", color: "var(--color-cloud)" }}>
        <span style={styles.tableName}>{game.name}</span>
      </td>
      <td style={{ padding: "12px 14px" }}>
        <Badge variant="info">{game.platform}</Badge>
      </td>
      <td style={{ padding: "12px 14px", textAlign: "center", fontSize: "var(--font-size-xs)", color: "var(--color-cloud-dim)" }}>
        {game.maxPlayers > 1 ? `${game.maxPlayers}p` : "1p"}
      </td>
      {tab === "recent" && (
        <td style={{ padding: "12px 14px", whiteSpace: "nowrap", color: "var(--color-cloud-dim)" }}>
          {formatRelativeAge(game.playedAt)}
        </td>
      )}
      <td style={{ padding: "8px 14px", textAlign: "right" }}>
        <div className="library-row-actions">
          <div className="library-row-secondary-actions">
            {gameActions.canFavorite && gameActions.onToggleFavorite && <button aria-label={gameActions.isFavorite(game.id) ? `Remove ${game.name} from favorites` : `Add ${game.name} to favorites`} onClick={(e) => gameActions.onToggleFavorite?.(game.id, e)}>{gameActions.isFavorite(game.id) ? <Star20Filled /> : <Star20Regular />}</button>}
            {gameActions.canPin && gameActions.onTogglePin && <button aria-label={gameActions.isPinned(game.id) ? `Unpin ${game.name}` : `Pin ${game.name}`} onClick={(e) => gameActions.onTogglePin?.(game.id, e)}>{gameActions.isPinned(game.id) ? <Pin20Filled /> : <Pin20Regular />}</button>}
            {gameActions.canRename && gameActions.onRename && <button aria-label={`Rename ${game.name}`} onClick={(e) => { e.stopPropagation(); gameActions.onRename?.(game); }}><Edit20Regular /></button>}
          </div>
          {(gameActions.canFavorite || gameActions.canPin || gameActions.canRename || gameActions.onChooseHost) && <details className="library-row-overflow">
              <summary aria-label={`More actions for ${game.name}`}><span aria-hidden="true">⋯</span></summary>
              <div className="library-row-overflow-actions">
                {gameActions.canFavorite && gameActions.onToggleFavorite && <button aria-label={gameActions.isFavorite(game.id) ? `Remove ${game.name} from favorites` : `Add ${game.name} to favorites`} onClick={(e) => gameActions.onToggleFavorite?.(game.id, e)}>{gameActions.isFavorite(game.id) ? <Star20Filled /> : <Star20Regular />}<span>{gameActions.isFavorite(game.id) ? "Remove favorite" : "Add favorite"}</span></button>}
                {gameActions.canPin && gameActions.onTogglePin && <button aria-label={gameActions.isPinned(game.id) ? `Unpin ${game.name}` : `Pin ${game.name}`} onClick={(e) => gameActions.onTogglePin?.(game.id, e)}>{gameActions.isPinned(game.id) ? <Pin20Filled /> : <Pin20Regular />}<span>{gameActions.isPinned(game.id) ? "Unpin" : "Pin"}</span></button>}
                {gameActions.canRename && gameActions.onRename && <button aria-label={`Rename ${game.name}`} onClick={(e) => { e.stopPropagation(); gameActions.onRename?.(game); }}><Edit20Regular /><span>Rename</span></button>}
                {gameActions.onChooseHost && <button disabled={launchingGame === game.id} aria-label={`Choose host for ${game.name}`} onClick={(e) => { e.stopPropagation(); gameActions.onChooseHost?.(game.id); }}><Desktop20Regular /><span>Choose host…</span></button>}
              </div>
            </details>}
          <Button disabled={!hasServers || launchingGame === game.id} variant="primary" size="sm" aria-label={`Play ${game.name}`} onClick={(e) => { e.stopPropagation(); gameActions.onPlay(game.id); }}>
            {launchingGame === game.id ? "Launching…" : "Play"}
          </Button>
        </div>
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
          { label: "XMB", href: "/xmb" },
          ...(session
            ? [{ label: "Sign out", href: "/api/auth/signout" }]
            : [{ label: "Sign in", href: "/api/auth/signin" }]),
        ]}
      />

      {!session && (
        <div style={styles.banner}>Sign in to play games on your server.</div>
      )}

      <section style={styles.section}>
        <h2 style={{ ...styles.h2, marginBottom: "var(--space-4)" }}>Library</h2>

        <LibraryToolbar
          activeSection={tab}
          counts={{ all: allTotal, favorites: favTotal, recent: recentTotal, pins: pinnedGames.length }}
          search={searchInput}
          platforms={uniquePlatforms}
          platformCounts={platformCounts}
          selectedPlatforms={selectedPlatforms}
          viewMode={viewMode}
          onSectionChange={setTab}
          onSearchChange={setSearchInput}
          onPlatformToggle={(platform) => setSelectedPlatforms((previous) => {
            const next = new Set(previous);
            if (next.has(platform)) next.delete(platform); else next.add(platform);
            return next;
          })}
          onClearPlatforms={() => setSelectedPlatforms(new Set())}
          onViewModeChange={setViewMode}
        />


        {/* Game grid / table */}
        {currentLoading && currentGames.length === 0 ? (
          viewMode === "grid" ? (
            <div className="library-skeleton-grid" aria-label="Loading games">
              {Array.from({ length: 8 }, (_, index) => <div key={index} className="library-skeleton-tile" />)}
            </div>
          ) : (
            <div aria-label="Loading games">
              {Array.from({ length: 8 }, (_, index) => <div key={index} className="library-skeleton-row" />)}
            </div>
          )
        ) : sortedGames.length === 0 ? (
          <p style={styles.empty}>
            {selectedPlatforms.size > 0
              ? "No games match the selected platforms."
              : tab === "all" ? "No games found." : tab === "favorites" ? "No favorites yet." : tab === "pins" ? "No pinned games yet." : "No recent plays."}
          </p>
        ) : viewMode === "grid" ? (
          <>
            {tab === "recent" ? recentGroups.map((group) => (
              <section key={group.date} style={styles.recentGroup}>
                <h3 style={styles.recentDate}>{formatRecentGroupLabel(group.date)}</h3>
                <div className="game-tile-grid">
                  {group.games.map((game) => (
                    <div key={game.id}>
                      {renderGameCard(game)}
                      <div style={styles.recentAge}>{formatRelativeAge(game.playedAt)}</div>
                    </div>
                  ))}
                </div>
              </section>
            )) : (
              <div className="game-tile-grid">
                {sortedGames.map((game) => renderGameCard(game))}
              </div>
            )}
          </>
        ) : (
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
                  {tab === "recent" && <th style={{ textAlign: "left", padding: "10px 14px", fontWeight: 600 }}>Last played</th>}
                  <th style={{ textAlign: "right", padding: "10px 14px", fontWeight: 600 }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {tab === "recent" ? recentGroups.flatMap((group, groupIndex) => [
                  <tr key={`date-${group.date}`}>
                    <th scope="rowgroup" colSpan={5} style={styles.recentTableDate}>{formatRecentGroupLabel(group.date)}</th>
                  </tr>,
                  ...group.games.map((game, index) => renderGameRow(
                    game,
                    recentGroups.slice(0, groupIndex).reduce((count, previous) => count + previous.games.length, 0) + index,
                  )),
                ]) : sortedGames.map((game, i) => renderGameRow(game, i))}
              </tbody>
            </table>
          </div>
        )}

        {hasMore && currentGames.length > 0 && (
          <div ref={sentinelRef} className={`library-load-sentinel${currentLoading ? " is-loading" : ""}`} aria-hidden="true" />
        )}
      </section>

      {/* ── Host picker ──────────────────────────────────────────── */}
      <Modal open={hostPickerGame !== null} onClose={closeHostPicker} title="Choose host">
        {launchError && (
          <div role="alert" style={{ marginBottom: "var(--space-4)", color: "var(--color-error)" }}>
            <p>{launchError}</p>
            {hostPickerGame && <Button variant="secondary" size="sm" disabled={hostPickerLoading || launchingGame !== null} onClick={() => chooseHost(hostPickerGame)}>Retry</Button>}
          </div>
        )}
        {hostPickerLoading ? (
          <p style={styles.empty}>Loading hosts…</p>
        ) : playableHosts.length === 0 ? (
          <p style={styles.empty}>{launchError ? "No host information is available." : "No hosts available."}</p>
        ) : (
          playableHosts.map((host) => {
            const playable = host.has_game && (host.status === "online" || host.status === "stale");
            return (
              <div key={host.server_id} style={styles.pickerRow}>
                <span style={styles.pickerName}>{host.name}</span>
                <Badge variant={statusVariant(host.status)}>{host.has_game ? host.status : `${host.status} · game unavailable`}</Badge>
                {!host.has_game && (
                  <span style={{ fontSize: "var(--font-size-xs)", color: "var(--color-muted)" }}>no game</span>
                )}
                <Button
                  variant="primary"
                  size="sm"
                  disabled={!playable || launchingGame !== null}
                  onClick={() => selectHost(hostPickerGame!, host.server_id, host.name)}
                  style={{ opacity: playable ? 1 : 0.4, cursor: playable ? "pointer" : "default" }}
                >
                  {launchingGame !== null ? "Launching…" : playable ? "Select" : "—"}
                </Button>
              </div>
            );
          })
        )}
        <label style={{ display: "flex", gap: "var(--space-2)", alignItems: "center", marginTop: "var(--space-4)" }}>
          <input disabled={hostPickerLoading || launchingGame !== null} type="checkbox" checked={rememberSelectedHost} onChange={(event) => setRememberSelectedHost(event.target.checked)} />
          Always use this host
        </label>
        <div style={{ marginTop: "var(--space-5)", textAlign: "center" }}>
          <Button variant="secondary" onClick={closeHostPicker}>Cancel</Button>
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

  recentGroup: { marginBottom: "var(--space-6)" },
  recentDate: {
    margin: "0 0 var(--space-3)",
    color: "var(--color-cloud)",
    fontSize: "var(--font-size-md)",
    letterSpacing: "0.06em",
  },
  recentAge: {
    marginTop: "var(--space-2)",
    color: "var(--color-cloud-dim)",
    fontSize: "var(--font-size-xs)",
  },
  recentTableDate: {
    padding: "12px 14px",
    textAlign: "left",
    color: "var(--color-accent)",
    background: "rgba(56,189,248,0.08)",
    letterSpacing: "0.06em",
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

  tableName: {
    fontWeight: 600,
    color: "var(--color-cloud)",
    fontSize: "var(--font-size-md)",
  },

  pickerRow: {
    display: "flex", alignItems: "center", gap: "var(--space-4)",
    padding: "var(--space-4) 0", borderBottom: "1px solid var(--color-sky-high)",
  },
  pickerName: { flex: 1, fontSize: "var(--font-size-md)", color: "var(--color-cloud)", fontFamily: "var(--font-mono)" },
};
