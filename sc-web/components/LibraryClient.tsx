"use client";

import { useState, useCallback, useEffect, useRef, useMemo } from "react";
import { useRouter } from "next/navigation";
import { Alert, Box, Chip, Paper, Stack, Typography, useMediaQuery, useTheme } from "@mui/material";
import { Badge, Button, Modal } from "@/components/ui";
import GameTile from "@/components/fluent/GameTile";
import GameTileContextMenu from "@/components/fluent/GameTileContextMenu";
import { downloadRom } from "@/lib/rom-transfer-client";
import AppHeader from "@/components/fluent/AppHeader";
import LibraryToolbar from "@/components/LibraryToolbar";
import RomUploadDropzone from "@/components/RomUploadDropzone";
import { Star, StarBorder, Edit, DesktopWindows } from "@mui/icons-material";
import { buildLanPlayerLaunchUrl, canUseLanPlayer, chooseLaunchHost, createLaunchRequestGate, formatLaunchError } from "@/lib/lan/launch";
import { probeLanHealth, type LanProbeResult } from "@/lib/lan/probe";
import { createLatestRequestGate, createLibraryFilters, createLibraryPageParams, createPlayableHostsParams, filterLibraryGames, formatRecentGroupLabel, formatRelativeAge, groupRecentGamesByLocalDate, isSavedGameFavorite, libraryGameKey, mergeLibraryPages, mergeRecentLibraryPages, migrateLegacyPinsToFavorites, toggleSavedGameFavorite, type LibraryGame, type LibrarySection } from "@/lib/ui/library-view-model";
import type { LanLibraryLink } from "@/lib/lan/library-handoff";
import { randomUuid } from "@/lib/browser/random-uuid";

// ── Types ─────────────────────────────────────────────────────────────

interface Game {
  id: string;
  serverId?: string | null;
  name: string;
  platform: string;
  maxPlayers: number;
  playedAt?: string;
  coverUrl?: string | null;
  verification?: { state: "verified" | "unverified" } | null;
  alwaysOn?: boolean;
  freePlay?: boolean;
  public?: boolean;
}

interface GameActionModel {
  canFavorite: boolean;

  canRename: boolean;
  canDelete: boolean;
  isFavorite: (game: Game) => boolean;

  onPlay: (game: Game) => void;
  onToggleFavorite?: (game: Game, e: React.MouseEvent) => void;

  onRename?: (game: Game) => void;
  onChooseHost?: (game: Game) => void;
  onDelete?: (game: Game) => void;
  onDownload?: (game: Game) => void;
  /** Admin flag toggles (Living Cabinet wall, #762). */
  canToggleFlags: boolean;
  onTogglePublic?: (game: Game) => void;
  onToggleAlwaysOn?: (game: Game) => void;
  onToggleFreePlay?: (game: Game) => void;
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
  lanLibraries?: LanLibraryLink[];
  session: { user?: { id?: string; name?: string | null; email?: string | null } } | null;
  isLanProxy?: boolean;
  adminServers?: { id: string; name: string; status: string }[];
}

const PAGE_SIZE = 100;


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
    token = randomUuid();
    document.cookie = `sc_csrf_token=${encodeURIComponent(token)}; Path=/; SameSite=Lax`;
  }
  return { "Content-Type": "application/json", "x-csrf-token": decodeURIComponent(token) };
}

// ── Favorites helpers ─────────────────────────────────────────────────
const LS_FAVORITES = "sc_favorites";
const LS_PINS = "sc_pins";
const LS_RENAMES = "sc_renames";

function loadFavorites(): Set<string> {
  try { return new Set(JSON.parse(localStorage.getItem(LS_FAVORITES) || "[]")); }
  catch { return new Set(); }
}
function saveFavorites(ids: Set<string>) {
  localStorage.setItem(LS_FAVORITES, JSON.stringify([...ids]));
}
function loadRenames(): Record<string, string> {
  try { return JSON.parse(localStorage.getItem(LS_RENAMES) || "{}"); }
  catch { return {}; }
}
function saveRenames(renames: Record<string, string>) {
  localStorage.setItem(LS_RENAMES, JSON.stringify(renames));
}

// ── Component ─────────────────────────────────────────────────────────

export default function LibraryClient({ serverIds, lanLibraries = [], session, isLanProxy = false, adminServers = [] }: LibraryClientProps) {
  const router = useRouter();
  const theme = useTheme();
  const isNarrow = useMediaQuery(theme.breakpoints.down("sm"));

  const [hostPickerGame, setHostPickerGame] = useState<Game | null>(null);
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
  const [allLoading, setAllLoading] = useState(true);
  const [serverPlatforms, setServerPlatforms] = useState<{ name: string; count: number }[]>([]); // start loading — suppresses stale handoff flash
  const [fetchError, setFetchError] = useState(false);
  const hasServers = serverIds.length > 0 || allGames.some((game) => Boolean(game.serverId));
  const needsLanHandoff = session !== null && lanLibraries.length > 0;


  const [recentGames, setRecentGames] = useState<Game[]>([]);
  const [recentTotal, setRecentTotal] = useState(0);
  const [recentLoading, setRecentLoading] = useState(false);
  const recentRequests = useRef(createLatestRequestGate());

  const [favoriteIds, setFavoriteIds] = useState<Set<string>>(new Set());


  const sentinelRef = useRef<HTMLDivElement>(null);

  // Favorites are intentionally browser-local, including on paired LAN pages;
  // server-provided preference fields belong to the standalone sc-server UI.
  // Fold browser-local legacy pins into Favorites once without losing data.
  useEffect(() => {
    try {
      setFavoriteIds(migrateLegacyPinsToFavorites(localStorage, LS_FAVORITES, LS_PINS));
    } catch (error) {
      console.warn("Could not migrate legacy pins to Favorites; legacy data was retained", error);
      setFavoriteIds(loadFavorites());
    }
  }, []);


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
    const offset = reset ? 0 : current.length;
    if (!reset && offset >= total && total > 0) return;
    setAllLoading(true);
    try {
      const primaryPlatform = selectedPlatforms.size === 1 ? [...selectedPlatforms][0] : undefined;
      const data = await fetchPage("/api/games", createLibraryPageParams(PAGE_SIZE, offset, searchTerm, primaryPlatform));
      setAllGames(reset ? data.games : mergeLibraryPages(current, data.games));
      setAllTotal(data.total);
      setFetchError(false);
      // Use server-returned platform facets as the canonical list
      if (data.platforms) setServerPlatforms(data.platforms);
      // Apply any locally stored renames to freshly loaded games
      if (reset) {
        const renames = loadRenames();
        if (Object.keys(renames).length > 0) {
          setAllGames((games) => games.map((g) => renames[g.id] ? { ...g, name: renames[g.id] } : g));
        }
      }
    } catch {
      if (reset) {
        setAllGames([]);
        setAllTotal(0);
        setFetchError(true);
      }
    } finally {
      setAllLoading(false);
    }
  }, [fetchPage]);


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
    } catch {
      if (reset && recentRequests.current.isCurrent(generation)) {
        setRecentGames([]);
        setRecentTotal(0);
      }
    } finally {
      if (recentRequests.current.isCurrent(generation)) setRecentLoading(false);
    }
  }, [recentLoading, fetchPage]);

  useEffect(() => {
    loadAllGames(true, search, [], 0);
  }, [search]);

  useEffect(() => {
    if (needsLanHandoff) return;
    if (tab === "recent") loadRecent(true, search, [], 0);
  }, [tab, search, needsLanHandoff]);

  // ── Infinite scroll sentinel ────────────────────────────────────

  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) {
          if (tab === "all" && allGames.length < allTotal) {
            loadAllGames(false, search, allGames, allTotal);
          } else if (tab === "favorites" && allGames.length < allTotal) {
            loadAllGames(false, search, allGames, allTotal);
          } else if (tab === "recent" && recentGames.length < recentTotal) {
            loadRecent(false, search, recentGames, recentTotal);
          }
        }
      },
      { threshold: 0.1 },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [tab, allGames.length, allTotal, recentGames.length, recentTotal, search]);

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

  const openHostPicker = useCallback((game: Game, visible = true) => {
    launchAbort.current?.abort();
    launchAbort.current = new AbortController();
    const generation = launchGate.current.beginRequest();
    setHostPickerGame(visible ? game : null);
    setPlayableHosts([]);
    setLanProbeByServer({});
    setRememberSelectedHost(false);
    setLaunchError(null);
    setHostPickerLoading(true);
    return generation;
  }, []);

  const navigateToGame = useCallback(async (gameId: string, serverId: string, generation: number, lanPlayerUrls?: string[] | null) => {
    const hostToken = randomUuid();
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

  const loadHosts = async (game: Game, automatic: boolean) => {
    if (!game.serverId || !launchGate.current.tryBeginLaunch()) return;
    const generation = openHostPicker(game, !automatic);
    const gameKey = libraryGameKey(game);
    setLaunchingGame(gameKey);
    try {
      const query = new URLSearchParams(createPlayableHostsParams(game));
      const resp = await fetch(`/api/playable-hosts?${query}`, { signal: launchAbort.current?.signal });
      if (!resp.ok) throw await responseError(resp, "Could not load hosts");
      const data = await resp.json() as { hosts?: PlayableHost[] };
      if (!launchGate.current.isCurrent(generation)) return;
      const hosts = Array.isArray(data.hosts) ? data.hosts : [];
      setPlayableHosts(hosts);
      setHostPickerLoading(false);

// Prefer the game's owning server over cookie-stored preference.
// Opaque game IDs are server-specific — a cookie from Bazzite
// won't work for a game owned by VAULT.
      const host = automatic ? chooseLaunchHost(hosts, game.serverId || getPreferredServer(game.id)) : null;
      if (host) {
        const probe = host.capabilities.lan
          ? await probeLanHealth(host.lan?.health_urls, { timeoutMs: 1_200 })
          : { reachable: false, reason: "no_urls" } as LanProbeResult;
        if (!launchGate.current.isCurrent(generation)) return;
        await navigateToGame(game.id, host.server_id, generation, canAttemptLanLaunch(probe, host) ? host.lan?.player_urls : null);
        if (launchGate.current.isCurrent(generation)) closeHostPicker();
        return;
      }
      setHostPickerGame(game);
      await probePlayableHosts(hosts, generation);
    } catch (error) {
      if (launchGate.current.isCurrent(generation)) {
        setHostPickerGame(game);
        setHostPickerLoading(false);
        setLaunchError(formatLaunchError(error, "Could not start the game. Please retry."));
      }
    } finally {
      launchGate.current.finishLaunch();
      setLaunchingGame(null);
    }
  };

  const handlePlay = (game: Game) => {
    void loadHosts(game, true);
  };

  const chooseHost = (game: Game) => void loadHosts(game, false);

  const selectHost = async (game: Game, serverId: string, _serverName: string) => {
    if (!launchGate.current.tryBeginLaunch()) return;
    const generation = launchGate.current.beginRequest();
    const host = playableHosts.find((candidate) => candidate.server_id === serverId);
    setLaunchingGame(libraryGameKey(game));
    setLaunchError(null);
    try {
      await navigateToGame(game.id, serverId, generation, host ? lanPlayerUrlsWhenDirectOrPolicyBlocked(host) : null);
      if (!launchGate.current.isCurrent(generation)) return;
      if (rememberSelectedHost) setPreferredServer(game.id, serverId);
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
      setRecentGames(update);
      cancelRename();
    } catch { setEditSaving(false); }
  }, [editName, allGamesRef, cancelRename]);

  const handleEditKey = useCallback((e: React.KeyboardEvent, gameId: string) => {
    if (e.key === "Enter") saveRename(gameId);
    if (e.key === "Escape") cancelRename();
  }, [saveRename, cancelRename]);

  // ── Favorite toggle ─────────────────────────────────────────────

  const handleToggleFavorite = useCallback((game: Game, e: React.MouseEvent) => {
    e?.stopPropagation?.();
    setFavoriteIds((prev) => {
      const next = toggleSavedGameFavorite(prev, game);
      saveFavorites(next);
      return next;
    });
  }, []);


  // ── Current tab's game list ─────────────────────────────────────

  const currentGames = tab === "recent" ? recentGames : allGames;
  const currentTotal = tab === "recent" ? recentTotal : allTotal;
  const currentLoading = tab === "recent" ? recentLoading : allLoading;
  const hasMore = currentGames.length < currentTotal;

  const sortedGames = useMemo(() => {
    const normalized: LibraryGame[] = currentGames.map((game, index) => ({
      ...game,
      favorite: isSavedGameFavorite(favoriteIds, game),

      recentRank: tab === "recent" ? index : null,
      serverId: game.serverId ?? null,
      coverUrl: game.coverUrl ?? null,
    }));
    const filtered = filterLibraryGames(normalized, createLibraryFilters(tab, search, selectedPlatforms));
    const byId = new Map(currentGames.map((game) => [libraryGameKey(game), game]));
    return filtered.map((game) => byId.get(libraryGameKey(game))!);
  }, [currentGames, favoriteIds, search, selectedPlatforms, tab]);
  const recentGroups = useMemo(
    () => tab === "recent"
      ? groupRecentGamesByLocalDate(sortedGames)
      : [],
    [sortedGames, tab],
  );

  // ── Render helpers ──────────────────────────────────────────────

  const isAdmin = adminServers.length > 0;

  const gameActions: GameActionModel = {
    canFavorite: true,
    canRename: true,
    canDelete: isAdmin,
    isFavorite: (game: Game) => isSavedGameFavorite(favoriteIds, game),

    onPlay: handlePlay,
    onToggleFavorite: handleToggleFavorite,
    onRename: startRename,
    onChooseHost: hasServers ? chooseHost : undefined,
    onDelete: isAdmin ? handleDelete : undefined,
    onDownload: isAdmin ? handleDownload : undefined,
    canToggleFlags: isAdmin,
    onTogglePublic: isAdmin ? handleToggleFlag("public") : undefined,
    onToggleAlwaysOn: isAdmin ? handleToggleFlag("alwaysOn") : undefined,
    onToggleFreePlay: isAdmin ? handleToggleFlag("freePlay") : undefined,
  };

  // ── Flag toggle handler (Living Cabinet wall, #762) ─────────────

  function handleToggleFlag(flag: "public" | "alwaysOn" | "freePlay") {
    return async (game: Game) => {
      const serverId = game.serverId ?? adminServers[0]?.id;
      if (!serverId) return;

      try {
        const res = await fetch("/api/games/flags", {
          method: "PATCH",
          headers: csrfHeaders(),
          body: JSON.stringify({
            serverId,
            gameId: game.id,
            [flag]: !(
              flag === "public" ? game.public
              : flag === "freePlay" ? game.freePlay
              : game.alwaysOn
            ),
          }),
        });
        const data = await res.json() as { error?: string };
        if (!res.ok) {
          alert(data.error ?? "Update failed");
          return;
        }
        // Refresh the library so the new flag state is reflected
        window.location.reload();
      } catch {
        alert("Network error — flag update may not have been applied");
      }
    };
  }

  // ── Delete handler ──────────────────────────────────────────────

  async function handleDelete(game: Game) {
    const confirmed = window.confirm(
      `Delete "${game.name}"?\n\nThis permanently removes the game from the server. This action cannot be undone.`,
    );
    if (!confirmed) return;

    const serverId = game.serverId ?? adminServers[0]?.id;
    if (!serverId) return;

    try {
      const res = await fetch(`/api/servers/${encodeURIComponent(serverId)}/delete-game`, {
        method: "POST",
        headers: csrfHeaders(),
        body: JSON.stringify({ game_id: game.id }),
      });
      const data = await res.json() as { ok?: boolean; error?: string };
      if (!res.ok || !data.ok) {
        alert(data.error ?? "Deletion failed");
        return;
      }
      // Refresh the library — the game will disappear on next poll
      window.location.reload();
    } catch {
      alert("Network error — deletion may not have been processed");
    }
  }

  // ── Download handler ─────────────────────────────────────────────

  async function handleDownload(game: Game) {
    const serverId = game.serverId ?? adminServers[0]?.id;
    if (!serverId) return;

    try {
      await downloadRom(serverId, game.id, game.name);
    } catch (err: any) {
      if (err?.message !== "Cancelled") {
        alert(err?.message ?? "Download failed");
      }
    }
  }

  // ── Render card ───────────────────────────────────────────────

  const renderGameCard = (game: Game) => (
    <GameTile
      key={libraryGameKey(game)}
      game={game}
      size="square"
      isFavorite={gameActions.isFavorite(game)}

      onPlay={gameActions.onPlay}
      onToggleFavorite={gameActions.onToggleFavorite}

      onEdit={gameActions.onRename}
      onChooseHost={gameActions.onChooseHost}
      onDelete={gameActions.canDelete ? gameActions.onDelete : undefined}
      onDownload={gameActions.onDownload ? gameActions.onDownload : undefined}
      isPublic={game.public}
      onTogglePublic={gameActions.canToggleFlags ? () => gameActions.onTogglePublic?.(game) : undefined}
      isAlwaysOn={game.alwaysOn}
      onToggleAlwaysOn={gameActions.canToggleFlags ? () => gameActions.onToggleAlwaysOn?.(game) : undefined}
      isFreePlay={game.freePlay}
      onToggleFreePlay={gameActions.canToggleFlags ? () => gameActions.onToggleFreePlay?.(game) : undefined}
      launching={launchingGame === libraryGameKey(game)}
    />
  );

  const renderGameRow = (game: Game, index: number) => (
    <tr
      key={libraryGameKey(game)}
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
          <Button
            disabled={!hasServers || launchingGame === libraryGameKey(game)}
            variant="primary"
            size="sm"
            aria-label={`Play ${game.name}`}
            onClick={(e) => { e.stopPropagation(); gameActions.onPlay(game); }}
          >
            {launchingGame === libraryGameKey(game) ? "Launching…" : "Play"}
          </Button>
          {(gameActions.canFavorite || gameActions.canRename || gameActions.canDelete || !!gameActions.onChooseHost || !!gameActions.onDownload || gameActions.canToggleFlags) && (
            <GameTileContextMenu
              game={game}
              isFavorite={gameActions.isFavorite(game)}
              onToggleFavorite={gameActions.canFavorite ? () => gameActions.onToggleFavorite?.(game, {} as React.MouseEvent) : undefined}
              onRename={gameActions.canRename ? () => gameActions.onRename?.(game) : undefined}
              onChooseHost={gameActions.onChooseHost ? () => gameActions.onChooseHost?.(game) : undefined}
              onDelete={gameActions.canDelete ? () => gameActions.onDelete?.(game) : undefined}
              onDownload={gameActions.onDownload ? () => gameActions.onDownload?.(game) : undefined}
              isPublic={game.public}
              onTogglePublic={gameActions.canToggleFlags ? () => gameActions.onTogglePublic?.(game) : undefined}
              isAlwaysOn={game.alwaysOn}
              onToggleAlwaysOn={gameActions.canToggleFlags ? () => gameActions.onToggleAlwaysOn?.(game) : undefined}
              isFreePlay={game.freePlay}
              onToggleFreePlay={gameActions.canToggleFlags ? () => gameActions.onToggleFreePlay?.(game) : undefined}
              triggerAriaLabel={`More actions for ${game.name}`}
            />
          )}
        </div>
      </td>
    </tr>
  );

  // Auto-switch to cards on mobile — table requires horizontal scroll at narrow widths
  const effectiveViewMode = isNarrow ? "grid" : viewMode;

  return (
    <main style={styles.main}>
      <AppHeader
        userName={session?.user?.name || session?.user?.email || undefined}
        links={[
          { label: "Home", href: "/" },
          { label: "Library", href: "/library" },
          ...(session ? [{ label: "Dashboard", href: "/servers" }] : []),
          ...(session
            ? [{ label: "Sign out", href: "/api/auth/signout" }]
            : isLanProxy ? [] : [{ label: "Sign in", href: "/api/auth/signin" }]),
        ]}
      />

      {!session && !isLanProxy && (
        <Alert severity="info" sx={{ mx: 2, mt: 2 }}>Sign in to play games on your server.</Alert>
      )}

      {fetchError && !allLoading && allGames.length === 0 && !needsLanHandoff && (
        <Alert severity="warning" sx={{ mx: 2, mt: 2 }}>
          Server is offline. Games will appear when your server reconnects.
        </Alert>
      )}

      <section style={styles.section}>
        <h2 style={{ ...styles.h2, marginBottom: "var(--space-4)" }}>Library</h2>

        {needsLanHandoff && allGames.length === 0 && !allLoading && (
          <Paper variant="outlined" sx={{ p: 3, mb: 3 }}>
            <Stack spacing={1.5}>
              <Typography variant="h6">Your games stay on sc-server</Typography>
              <Typography color="text.secondary">No games synced yet. Open the library on your LAN server, or upgrade sc-server to sync.</Typography>
              <Stack direction="row" spacing={1} sx={{ flexWrap: "wrap", gap: 1 }}>
              {lanLibraries.map((library) => (
                <Button key={library.serverId} href={library.url} variant="secondary" size="sm">
                  {`Open ${library.name} library`}
                </Button>
              ))}
              </Stack>
            </Stack>
          </Paper>
        )}

        <LibraryToolbar
          activeSection={tab}
          counts={{ all: allTotal, favorites: favoriteIds.size, recent: recentTotal }}
          search={searchInput}
          platforms={serverPlatforms.map((p) => p.name)}
          platformCounts={Object.fromEntries(serverPlatforms.map((p) => [p.name, p.count]))}
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
        {session && adminServers.length > 0 && (
          <div style={{ marginBottom: "var(--space-4)" }}>
            <RomUploadDropzone
              adminServers={adminServers}
              onUploadComplete={() => loadAllGames(true, search, [], 0)}
            />
          </div>
        )}


        {/* Game grid / table */}
        {currentLoading && currentGames.length === 0 ? (
          effectiveViewMode === "grid" ? (
            <div className="library-skeleton-grid" aria-label="Loading games">
              {Array.from({ length: 8 }, (_, index) => <div key={index} className="library-skeleton-tile" />)}
            </div>
          ) : (
            <div aria-label="Loading games">
              {Array.from({ length: 8 }, (_, index) => <div key={index} className="library-skeleton-row" />)}
            </div>
          )
        ) : sortedGames.length === 0 ? (
          <Typography color="text.secondary" sx={{ py: 6, textAlign: "center" }}>
            {needsLanHandoff && allGames.length === 0
              ? "No games synced from your servers. Upgrade sc-server on your LAN host to v0.11.3."
              : selectedPlatforms.size > 0
              ? "No games match the selected platforms."
              : tab === "all" ? "No games found." : tab === "favorites" ? "No favorites yet." : "No recent plays."}
          </Typography>
        ) : effectiveViewMode === "grid" ? (
          <>
            {tab === "recent" ? recentGroups.map((group) => (
              <section key={group.date} style={styles.recentGroup}>
                <Typography variant="h6" sx={{ mb: 1.5 }}>{formatRecentGroupLabel(group.date)}</Typography>
                <div className="game-tile-grid">
                  {group.games.map((game) => (
                    <div key={libraryGameKey(game)}>
                      {renderGameCard(game)}
                      <Typography variant="caption" color="text.secondary" sx={{ display: "block", mt: 0.5 }}>{formatRelativeAge(game.playedAt)}</Typography>
                    </div>
                  ))}
                </div>
              </section>
            )) : (() => {
              // Group games by platform for collapsible sections
              const groups = new Map<string, Game[]>();
              for (const g of sortedGames) {
                const list = groups.get(g.platform) || [];
                list.push(g);
                groups.set(g.platform, list);
              }
              return [...groups.entries()].map(([platform, games]) => (
                <details key={platform} open style={{ marginBottom: 16 }}>
                  <Box component="summary" sx={{ display: "flex", alignItems: "center", justifyContent: "space-between", cursor: "pointer", py: 1, color: "text.primary", fontWeight: 600 }}>
                    <Typography component="span" variant="h6">{platform}</Typography>
                    <Chip label={games.length} size="small" color="primary" variant="outlined" />
                  </Box>
                  <div className="game-tile-grid" style={{ marginTop: 12 }}>
                    {games.map((game) => renderGameCard(game))}
                  </div>
                </details>
              ));
            })()}
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
          <Alert severity="error" role="alert" sx={{ mb: 2 }}>
            <Stack spacing={1}>
              <Typography>{launchError}</Typography>
            {hostPickerGame && <Button variant="secondary" size="sm" disabled={hostPickerLoading || launchingGame !== null} onClick={() => chooseHost(hostPickerGame)}>Retry</Button>}
            </Stack>
          </Alert>
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
  lanHandoff: {
    display: "grid",
    gap: "var(--space-3)",
    marginBottom: "var(--space-5)",
    padding: "var(--space-5)",
    border: "1px solid var(--color-accent)",
    borderRadius: 2,
    background: "var(--color-sky-mid)",
    color: "var(--color-cloud)",
  },
  lanHandoffLinks: { display: "flex", flexWrap: "wrap", gap: "var(--space-3)" },
  lanHandoffLink: {
    display: "inline-flex",
    minHeight: 38,
    alignItems: "center",
    padding: "0 var(--space-4)",
    border: "1px solid var(--color-accent)",
    borderRadius: 2,
    background: "var(--color-accent)",
    color: "var(--color-sky-deep)",
    fontWeight: 700,
    textDecoration: "none",
  },

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
  platformSummary: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: "8px 4px",
    cursor: "pointer",
    color: "var(--color-cloud)",
    fontSize: "var(--font-size-md)",
    fontFamily: "var(--font-mono)",
    fontWeight: 600,
    textTransform: "uppercase",
    letterSpacing: "0.04em",
    borderBottom: "1px solid var(--color-border-default)",
    listStyle: "none",
  },
  platformCount: {
    color: "var(--color-cloud-dim)",
    fontSize: "var(--font-size-sm)",
    fontWeight: 400,
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
