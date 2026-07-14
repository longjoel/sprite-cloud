"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import GamePlayer from "@/components/GamePlayer";
import XmbSettings, { hasXmbSettingsAccess, type XmbServer } from "@/components/xmb/XmbSettings";
import { LIBRARY_SECTIONS, filterLibraryGames, normalizeRecentGameIds, type LibraryGame, type LibrarySection } from "@/lib/ui/library-view-model";
import { loadXmbAuthenticatedData } from "@/lib/ui/xmb-authenticated-load";
import {
  activateXmbNavigation,
  activateXmbSettingsAction,
  focusXmbSettingsAction,
  getXmbNavigation,
  moveXmbNavigation,
  reconcileXmbNavigation,
  type XmbCategoryId,
  type XmbNavigationId,
  type XmbNavigationState,
} from "@/lib/ui/xmb-navigation";

// ── Types ────────────────────────────────────────────────────────────

interface Game extends LibraryGame {
  maxPlayers?: number;
}

interface RawGame {
  id: string;
  name: string;
  platform: string;
  maxPlayers?: number;
  serverId?: string | null;
  server_id?: string | null;
  coverUrl?: string | null;
  cover_url?: string | null;
  favorite?: boolean;
  favorited?: boolean;
  pinned?: boolean;
}

interface SubCategory {
  id: string; label: string; section?: LibrarySection; platforms?: readonly string[];
}

// ── Constants ────────────────────────────────────────────────────────

const CATEGORY_PRESENTATION: Record<XmbNavigationId, { label: string; icon: string }> = {
  games: { label: "Game", icon: "▶" },
  settings: { label: "Settings", icon: "⚙" },
  classic: { label: "Classic", icon: "🏠" },
};

const sectionLabel = (section: LibrarySection) => LIBRARY_SECTIONS.find(({ id }) => id === section)!.label;
const SUB_CATEGORIES: SubCategory[] = [
  { id: "favorites", label: "★", section: "favorites" },
  { id: "recent", label: "🕐", section: "recent" },
  { id: "pins", label: "📌", section: "pins" },
  { id: "all", label: sectionLabel("all"), section: "all" },
  { id: "nes", label: "NES", section: "all", platforms: ["NES"] },
  { id: "snes", label: "SNES", section: "all", platforms: ["SNES"] },
  { id: "genesis", label: "Genesis", section: "all", platforms: ["Genesis"] },
  { id: "gba", label: "GBA", section: "all", platforms: ["Game Boy Advance"] },
  { id: "gb", label: "GB/GBC", section: "all", platforms: ["Game Boy", "Game Boy Color"] },
];

// ── Component ─────────────────────────────────────────────────────────

export default function XmbPage() {
  const router = useRouter();
  const { data: session, status } = useSession();

  const [navigation, setNavigation] = useState<XmbNavigationState>({
    focusedId: "games",
    activeCategory: "games",
  });
  const [focusedSettingsAction, setFocusedSettingsAction] = useState(0);
  const [focusedSub, setFocusedSub] = useState(0);
  const [focusedGame, setFocusedGame] = useState(0);
  const [games, setGames] = useState<Game[]>([]);
  const [search, setSearch] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [bootstrap, setBootstrap] = useState<{
    servers: XmbServer[];
    library: { totalGames: number; pinnedCount: number } | null;
    ice: { stunConfigured: boolean; turnConfigured: boolean; transportPolicy: string };
  } | null>(null);
  const [recentIds, setRecentIds] = useState<string[]>([]);
  const [playing, setPlaying] = useState(false);
  const [playGame, setPlayGame] = useState<{ gameId: string; serverId: string; hostToken?: string; gameName?: string; platform?: string } | null>(null);
  const [fadeIn, setFadeIn] = useState(false);
  const [kbdPort, setKbdPort] = useState(0); // 0 = auto, 1-4 = fixed port
  const [isMobile, setIsMobile] = useState(false);
  const settingsAvailable = bootstrap !== null
    && hasXmbSettingsAccess(status === "authenticated", bootstrap.servers);
  const navigationItems = getXmbNavigation(settingsAvailable);

  const containerRef = useRef<HTMLDivElement>(null);
  const gameListRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<any>(null);
  const fadingOut = useRef(false);

  // ── Auth guard — redirect to signin if not logged in ──────────────
  useEffect(() => {
    if (status === "unauthenticated") {
      router.replace("/api/auth/signin");
    }
  }, [status, router]);

  // Bootstrap/auth can remove Settings after it was focused. Keep a real body active.
  useEffect(() => {
    setNavigation((current) => reconcileXmbNavigation(current, settingsAvailable));
  }, [settingsAvailable]);

  const selectNavigation = useCallback((id: XmbNavigationId) => {
    setNavigation((current) => ({
      focusedId: id,
      activeCategory: id === "classic" ? current.activeCategory : id as XmbCategoryId,
    }));
  }, []);

  const moveNavigation = useCallback((delta: -1 | 1) => {
    setNavigation((current) => moveXmbNavigation(current, settingsAvailable, delta));
  }, [settingsAvailable]);

  const moveSettingsAction = useCallback((delta: -1 | 1) => {
    const root = containerRef.current;
    if (!root) return;
    const next = focusXmbSettingsAction(root, focusedSettingsAction + delta);
    if (next !== null) setFocusedSettingsAction(next);
  }, [focusedSettingsAction]);

  const activateNavigation = useCallback(() => {
    setNavigation(activateXmbNavigation(navigation, settingsAvailable, (href) => router.push(href)));
  }, [navigation, router, settingsAvailable]);

  // ── Mobile detection ────────────────────────────────────────────────
  useEffect(() => {
    const check = () => {
      const touch = typeof window !== "undefined" && "ontouchstart" in window;
      const coarse = window.matchMedia("(pointer: coarse)").matches;
      const small = window.innerWidth < 768;
      setIsMobile(touch && (coarse || small));
    };
    check();
    window.addEventListener("resize", check);
    return () => window.removeEventListener("resize", check);
  }, []);

  // ── Touch swipe for category switching ─────────────────────────────
  useEffect(() => {
    if (!isMobile) return;
    let startX = 0;
    const onTouchStart = (e: TouchEvent) => { startX = e.touches[0].clientX; };
    const onTouchEnd = (e: TouchEvent) => {
      const dx = e.changedTouches[0].clientX - startX;
      if (Math.abs(dx) > 60) {
        moveNavigation(dx < 0 ? 1 : -1);
      }
    };
    window.addEventListener("touchstart", onTouchStart, { passive: true });
    window.addEventListener("touchend", onTouchEnd, { passive: true });
    return () => { window.removeEventListener("touchstart", onTouchStart); window.removeEventListener("touchend", onTouchEnd); };
  }, [isMobile, moveNavigation]);

  // ── Fetch games ──────────────────────────────────────────────────────
  useEffect(() => {
    const controller = new AbortController();
    (async () => {
      try {
        const query = search ? `?search=${encodeURIComponent(search)}&limit=200&pins_first=true` : "?limit=200&pins_first=true";
        const [res, favoritesRes] = await Promise.all([
          fetch(`/api/games${query}`, { signal: controller.signal }),
          status === "authenticated" ? fetch("/api/favorites?limit=200", { signal: controller.signal }) : Promise.resolve(null),
        ]);
        if (!res.ok) return;
        const data = await res.json();
        const favoritesData = favoritesRes?.ok ? await favoritesRes.json() : { games: [] };
        const favoriteIds = new Set<string>((favoritesData.games || []).map((game: { id: string }) => game.id));
        setGames((data.games || []).map((game: RawGame) => ({
          id: game.id,
          name: game.name,
          platform: game.platform,
          maxPlayers: game.maxPlayers,
          favorite: favoriteIds.has(game.id) || Boolean(game.favorite ?? game.favorited),
          pinned: Boolean(game.pinned),
          recentRank: null,
          serverId: game.serverId ?? game.server_id ?? null,
          coverUrl: game.coverUrl ?? game.cover_url ?? null,
        })));
      } catch (error) {
        if (!(error instanceof DOMException && error.name === "AbortError")) { /* fail silently */ }
      }
      if (!controller.signal.aborted) setLoaded(true);
    })();
    return () => controller.abort();
  }, [search, status]);

  // ── Fetch bootstrap + recent plays (once, when authenticated) ─────
  useEffect(() => {
    if (status !== "authenticated") return;
    const controller = new AbortController();
    void loadXmbAuthenticatedData({
      signal: controller.signal,
      fetcher: fetch,
      setBootstrap,
      setRecentIds,
    });
    return () => controller.abort();
  }, [status]);

  // ── Filtered games for current sub-category ──────────────────────────
  const sub = SUB_CATEGORIES[focusedSub];
  const normalizedGames = games.map((game) => ({
    ...game,
    recentRank: recentIds.includes(game.id) ? recentIds.indexOf(game.id) : null,
  }));
  const filteredGames = filterLibraryGames(normalizedGames, {
    section: sub?.section ?? "all",
    search,
    platforms: sub?.platforms,
  }) as Game[];

  // Clamp focused game index
  const safeGameIdx = Math.min(focusedGame, Math.max(0, filteredGames.length - 1));
  const selectedGame = filteredGames[safeGameIdx] ?? null;

  // ── Auto-scroll focused game into view ───────────────────────────────
  useEffect(() => {
    if (!gameListRef.current) return;
    const rows = gameListRef.current.querySelectorAll("[data-game-row]");
    const el = rows[safeGameIdx] as HTMLElement | undefined;
    if (el) el.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [safeGameIdx]);

  // ── DC command helper ─────────────────────────────────────────────────
  const sendDC = useCallback((cmd: Record<string, unknown>) => {
    const p = playerRef.current;
    if (!p?._dc || p._dc.readyState !== "open") return false;
    try { p._dc.send(JSON.stringify(cmd)); return true; } catch { return false; }
  }, []);

  const closePlayer = useCallback(() => {
    fadingOut.current = true;
    setFadeIn(false);
  }, []);

  const handlePlayerTransitionEnd = useCallback(() => {
    if (fadingOut.current) {
      fadingOut.current = false;
      setPlaying(false);
      setPlayGame(null);
    }
  }, []);

  // ── Escape listener (only active during play — lets gv-player handle all other keys) ──
  useEffect(() => {
    if (!playing) return;
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); closePlayer(); }
    };
    window.addEventListener("keydown", onEsc);
    return () => window.removeEventListener("keydown", onEsc);
  }, [playing, closePlayer]);

  // ── Port routing hotkeys (Ctrl+1-4, Ctrl+0, Ctrl+G) — always active when playing ──
  useEffect(() => {
    if (!playing) return;
    const onCtrlKey = (e: KeyboardEvent) => {
      if (!e.ctrlKey) return;
      if (e.key >= "1" && e.key <= "4") {
        e.preventDefault();
        const port = parseInt(e.key);
        setKbdPort(port);
        // Ctrl+1 → player 1, but emulator core uses 0-based port
        const p = playerRef.current || window.__gvPlayer;
        if (p) { p._seat = port - 1; }
        sendDC({ cmd: "kbd_port", port: port - 1 });
      } else if (e.key === "0") {
        e.preventDefault();
        setKbdPort(0);
        const p = playerRef.current || window.__gvPlayer;
        if (p) { p._seat = 0; }
        sendDC({ cmd: "kbd_port", port: 0 });
      } else if (e.key === "g") {
        e.preventDefault();
        const tg = window.__gvTouchGamepad;
        if (tg) { try { tg.toggle(); } catch {} }
      }
    };
    window.addEventListener("keydown", onCtrlKey);
    return () => window.removeEventListener("keydown", onCtrlKey);
  }, [playing, sendDC]);

  // ── XMB navigation keyboard handler (inactive during play) ──────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (playing) return;
      const target = e.target as HTMLElement | null;
      if (target?.matches("input, textarea, select, [contenteditable=true]")) return;
      if (e.key === "Enter" && target?.closest("[data-xmb-settings-action]")) return;
      if (e.key === "Enter" && target?.closest('a[href="/"]')) return;
      switch (e.key) {
        case "ArrowLeft":
          e.preventDefault();
          if (navigation.focusedId === "games" && focusedSub > 0) setFocusedSub((v) => v - 1);
          else moveNavigation(-1);
          break;
        case "ArrowRight":
          e.preventDefault();
          if (navigation.focusedId === "games" && focusedSub < SUB_CATEGORIES.length - 1) setFocusedSub((v) => v + 1);
          else moveNavigation(1);
          break;
        case "ArrowUp":
          e.preventDefault();
          if (navigation.activeCategory === "settings") moveSettingsAction(-1);
          else setFocusedGame((v) => Math.max(0, v - 1));
          break;
        case "ArrowDown":
          e.preventDefault();
          if (navigation.activeCategory === "settings") moveSettingsAction(1);
          else setFocusedGame((v) => Math.min(filteredGames.length - 1, v + 1));
          break;
        case "Enter":
          if (navigation.focusedId === "classic") activateNavigation();
          else if (navigation.focusedId === "games" && selectedGame) launchGame(selectedGame);
          else if (navigation.focusedId === "settings") moveSettingsAction(-1);
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [activateNavigation, filteredGames.length, focusedSub, moveNavigation, moveSettingsAction, navigation, playing, selectedGame]);

  // ── Gamepad polling ──────────────────────────────────────────────────
  useEffect(() => {
    if (playing) return; // gamepad owned by GamePlayer during play
    let prevState = "";
    const interval = setInterval(() => {
      const pads = navigator.getGamepads?.() ?? [];
      const pad = pads[0]; if (!pad) return;
      const state = `a${pad.axes[0]?.toFixed(1)},${pad.axes[1]?.toFixed(1)}|b${pad.buttons.slice(0, 16).map(b => b.pressed ? "1" : "0").join("")}`;
      if (state === prevState) return; prevState = state;

      const ax = pad.axes[0] ?? 0, ay = pad.axes[1] ?? 0;
      if (ax < -0.5) {
        if (navigation.focusedId === "games" && focusedSub > 0) setFocusedSub((v) => v - 1);
        else moveNavigation(-1);
      } else if (ax > 0.5) {
        if (navigation.focusedId === "games" && focusedSub < SUB_CATEGORIES.length - 1) setFocusedSub((v) => v + 1);
        else moveNavigation(1);
      } else if (ay < -0.5) {
        if (navigation.activeCategory === "settings") moveSettingsAction(-1);
        else setFocusedGame((v) => Math.max(0, v - 1));
      } else if (ay > 0.5) {
        if (navigation.activeCategory === "settings") moveSettingsAction(1);
        else setFocusedGame((v) => Math.min(filteredGames.length - 1, v + 1));
      } else if (pad.buttons[0]?.pressed) {
        prevState = "";
        if (navigation.focusedId === "classic") activateNavigation();
        else if (navigation.activeCategory === "settings" && containerRef.current) {
          activateXmbSettingsAction(containerRef.current, focusedSettingsAction);
        } else if (navigation.focusedId === "games" && selectedGame) launchGame(selectedGame);
      }
    }, 120);
    return () => clearInterval(interval);
  }, [activateNavigation, filteredGames.length, focusedSettingsAction, focusedSub, moveNavigation, moveSettingsAction, navigation, playing, selectedGame]);

  // ── Launch / close ────────────────────────────────────────────────────
  const launchGame = useCallback((game: Game) => {
    const sid = game.serverId;
    if (!sid) return;
    setPlayGame({
      gameId: game.id, serverId: sid,
      gameName: game.name, platform: game.platform,
    });
    setPlaying(true);
    setTimeout(() => setFadeIn(true), 50);
  }, []);

  // Capture GvPlayer instance when connected
  useEffect(() => {
    if (!playing) return;
    const interval = setInterval(() => {
      if (window.__gvPlayer?._dc?.readyState === "open") {
        playerRef.current = window.__gvPlayer;
        clearInterval(interval);
      }
    }, 200);
    return () => clearInterval(interval);
  }, [playing]);

  // ── Render categories ────────────────────────────────────────────────
  const renderCategories = () => (
    <div style={{ ...s.categories, ...(isMobile ? s.categoriesMobile : {}) }}>
      <input
        type="text"
        placeholder="Search…"
        value={search}
        onChange={(e) => { setSearch(e.target.value); setFocusedGame(0); }}
        style={s.searchInput}
        onClick={(e) => e.stopPropagation()}
      />
      <div style={s.catGroup}>
        {navigationItems.map((item) => {
          const presentation = CATEGORY_PRESENTATION[item.id];
          const style = {
            ...s.catItem,
            ...(isMobile ? s.catItemMobile : {}),
            ...(item.id === navigation.focusedId ? s.catFocused : {}),
          };
          const content = (
            <>
              <span style={s.catIcon}>{presentation.icon}</span>
              <span style={s.catLabel}>{presentation.label}</span>
            </>
          );
          return item.kind === "action" ? (
            <a
              key={item.id}
              href={item.href}
              style={style}
              title={presentation.label}
              onFocus={() => selectNavigation(item.id)}
              onMouseEnter={() => selectNavigation(item.id)}
            >
              {content}
            </a>
          ) : (
            <button
              type="button"
              key={item.id}
              style={style}
              onClick={() => selectNavigation(item.id)}
              onFocus={() => selectNavigation(item.id)}
              aria-pressed={item.id === navigation.activeCategory}
              title={presentation.label}
            >
              {content}
            </button>
          );
        })}
      </div>
    </div>
  );

  // ── Render sub-categories ─────────────────────────────────────────────
  const renderSubCategories = () => (
    <div style={s.subBar}>
      {SUB_CATEGORIES.map((sc, i) => (
        <div
          key={sc.id}
          style={{ ...s.subItem, ...(i === focusedSub ? s.subFocused : {}) }}
          onClick={() => { setFocusedSub(i); setFocusedGame(0); }}
        >
          {sc.label}
        </div>
      ))}
    </div>
  );

  // ── Render game list ──────────────────────────────────────────────────
  const renderGameList = () => (
    <div ref={gameListRef} style={s.gameList}>
      {filteredGames.map((game, i) => {
        const focused = i === safeGameIdx;
        const firstLetter = game.name.charAt(0).toUpperCase();
        const prevLetter = i > 0 ? filteredGames[i - 1]?.name.charAt(0).toUpperCase() : "";
        const showHeader = firstLetter !== prevLetter;
        return (
          <div key={game.id}>
            {showHeader && <div style={s.letterHeader}>{firstLetter}</div>}
            <div
              data-game-row
              style={{ ...s.gameRow, ...(focused ? s.gameFocused : {}) }}
              onClick={() => { setFocusedGame(i); launchGame(game); }}
              onMouseEnter={() => setFocusedGame(i)}
            >
              {game.coverUrl ? (
                <img src={game.coverUrl} alt="" style={s.cover} />
              ) : (
                <div style={s.coverPlaceholder}>🎮</div>
              )}
              <div style={s.gameInfo}>
                <div style={s.gameName}>{game.name}</div>
                <div style={s.gamePlatform}>{game.platform}</div>
              </div>
            </div>
          </div>
        );
      })}
      {loaded && filteredGames.length === 0 && (
        <div style={s.empty}>No games found</div>
      )}
    </div>
  );

  // ── Main render ───────────────────────────────────────────────────────
  return (
    <div ref={containerRef} style={s.shell}>
      {playing && playGame ? (
        <>
          {/* Player overlay */}
          <div
            style={{
              ...s.playerOverlay,
              opacity: fadeIn ? 1 : 0,
              pointerEvents: fadeIn ? "auto" : "none",
            }}
            onTransitionEnd={handlePlayerTransitionEnd}
          >
            <GamePlayer
              gameId={playGame.gameId}
              serverId={playGame.serverId}
              gameName={playGame.gameName}
              platform={playGame.platform}
              onClose={closePlayer}
              onConnected={() => {}}
              hidePipeline
              initialPipeline={{ ice: "done", server: "done" }}
              initialStatus="connecting"
              onPipelineChange={(_p: Record<string, string>) => {}}
            />
          </div>
          {/* Back hint */}
          <div style={s.backHint} onClick={closePlayer}>
            Press Esc or ○ to close  ·  Ctrl+1-4: port  ·  Ctrl+G: gamepad
          </div>
        </>
      ) : (
        <>
          {/* Background ambient */}
          <div style={s.bgGradient} />

          {/* Main XMB layout */}
          <div style={s.xmbBody}>
            {navigation.activeCategory === "games" && (
              <>
                {renderSubCategories()}
                {renderGameList()}
              </>
            )}
            {navigation.activeCategory === "settings" && (
              settingsAvailable && bootstrap
                ? <XmbSettings servers={bootstrap.servers} onActionFocus={setFocusedSettingsAction} />
                : null
            )}
          </div>

          {/* Bottom category bar */}
          {renderCategories()}
        </>
      )}
    </div>
  );
}

// ── Styles — dark space-gray theme ─────────────────────────────────────

const S = {
  accent: "rgba(56, 189, 248, 0.9)",
  accentDim: "rgba(56, 189, 248, 0.15)",
  text: "#e5e7eb",
  textDim: "#6b7280",
  bg: "#0a0e1a",
  bgCard: "rgba(17, 24, 39, 0.85)",
};

const s: Record<string, React.CSSProperties> = {
  shell: {
    width: "100vw", height: "100vh", position: "relative",
    background: S.bg, overflow: "hidden", fontFamily: "var(--font-mono), ui-monospace, monospace",
    color: S.text, userSelect: "none",
  },
  bgGradient: {
    position: "absolute", inset: 0, zIndex: 0,
    background: `radial-gradient(ellipse at 50% 30%, rgba(56,189,248,0.06) 0%, transparent 60%),
                 radial-gradient(ellipse at 80% 70%, rgba(99,102,241,0.04) 0%, transparent 50%)`,
  },
  statusBar: {
    position: "absolute", top: 0, left: 0, right: 0, zIndex: 2,
    height: 32, display: "flex", alignItems: "center", gap: 12,
    padding: "0 16px", background: "rgba(0,0,0,0.3)", backdropFilter: "blur(6px)",
    fontSize: "var(--font-size-xs)", borderBottom: "1px solid rgba(56,189,248,0.1)",
  },
  statusLabel: { color: S.accent, fontWeight: 600 },
  statusMeta: { color: "rgba(255,255,255,0.45)" },
  statusWarn: { color: "rgba(251,191,36,0.8)", marginLeft: "auto" },
  statusLink: {
    color: S.accent, textDecoration: "none", fontWeight: 500,
    marginLeft: 12, padding: "2px 8px", border: "1px solid rgba(56,189,248,0.2)",
    borderRadius: 4, fontSize: "var(--font-size-xs)",
  },
  xmbBody: {
    position: "absolute", inset: 0, bottom: "calc(72px + env(safe-area-inset-bottom))", zIndex: 1,
    display: "flex", flexDirection: "column", overflow: "hidden",
  },
  categories: {
    position: "absolute", bottom: 0, left: 0, right: 0, zIndex: 10,
    boxSizing: "border-box", height: "calc(68px + env(safe-area-inset-bottom))", display: "flex", alignItems: "center", justifyContent: "space-between",
    gap: 4, background: "rgba(0,0,0,0.6)", backdropFilter: "blur(12px)",
    borderTop: "1px solid rgba(255,255,255,0.04)", padding: "0 8px",
    paddingBottom: "env(safe-area-inset-bottom)",
  },
  catGroup: {
    display: "flex", alignItems: "center", gap: 4,
  },
  categoriesMobile: {
    height: "calc(56px + env(safe-area-inset-bottom))", gap: 0,
  },
  catItem: {
    display: "flex", flexDirection: "column", alignItems: "center",
    minHeight: 44, padding: "6px 20px", border: "none", borderRadius: 2, cursor: "pointer",
    background: "transparent", font: "inherit", textDecoration: "none",
    transition: "all 0.15s ease", color: S.textDim,
  },
  catItemMobile: {
    padding: "4px 12px", flex: 1, justifyContent: "center",
  },
  catFocused: {
    color: S.accent, background: S.accentDim,
    textShadow: "0 0 8px rgba(56,189,248,0.3)",
  },
  catIcon: { fontSize: 20, lineHeight: 1 },
  catLabel: { fontSize: 10, letterSpacing: "0.08em", textTransform: "uppercase", marginTop: 2 },
  subBar: {
    display: "flex", gap: 2, padding: "12px 16px 8px", overflowX: "auto",
    borderBottom: "1px solid rgba(255,255,255,0.04)",
  },
  subItem: {
    padding: "4px 14px", borderRadius: 2, fontSize: 12,
    cursor: "pointer", color: S.textDim, whiteSpace: "nowrap",
    letterSpacing: "0.04em", transition: "all 0.12s ease",
  },
  subFocused: { color: S.text, background: S.accentDim },
  searchInput: {
    padding: "4px 10px", border: "1px solid rgba(255,255,255,0.08)",
    background: "rgba(255,255,255,0.04)", color: S.text, borderRadius: 2,
    fontSize: 12, width: 140, outline: "none",
  },

  gameList: {
    flex: 1, overflowY: "auto", padding: "8px 16px",
  },
  letterHeader: {
    fontSize: 11, color: S.textDim, padding: "8px 4px 4px",
    borderBottom: "1px solid rgba(255,255,255,0.03)",
    letterSpacing: "0.06em", textTransform: "uppercase",
  },
  gameRow: {
    display: "flex", alignItems: "center", gap: 12,
    padding: "6px 8px", borderRadius: 2, cursor: "pointer",
    transition: "background 0.10s ease",
  },
  gameFocused: {
    background: S.accentDim, outline: `1px solid ${S.accent}`,
  },
  cover: {
    width: 44, height: 62, objectFit: "cover", borderRadius: 2,
    boxShadow: "0 2px 8px rgba(0,0,0,0.4)",
  },
  coverPlaceholder: {
    width: 44, height: 62, borderRadius: 2, background: "rgba(255,255,255,0.03)",
    display: "flex", alignItems: "center", justifyContent: "center",
    fontSize: 20, border: "1px solid rgba(255,255,255,0.06)",
  },
  gameInfo: { flex: 1, minWidth: 0 },
  gameName: { fontSize: 13, fontWeight: 500, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" },
  gamePlatform: { fontSize: 10, color: S.textDim, marginTop: 2 },
  loading: {
    textAlign: "center", color: S.textDim, fontSize: 13, padding: 40,
  },
  empty: {
    textAlign: "center", color: S.textDim, fontSize: 13, padding: 40,
    fontStyle: "italic",
  },
  placeholder: {
    flex: 1, display: "flex", alignItems: "center", justifyContent: "center",
    color: S.textDim, fontSize: 14, fontStyle: "italic",
  },
  playerOverlay: {
    position: "absolute", inset: 0, zIndex: 20,
    transition: "opacity 0.35s ease",
  },
  backHint: {
    position: "fixed", top: 12, left: "50%", transform: "translateX(-50%)",
    zIndex: 30, padding: "4px 16px", borderRadius: 2,
    background: "rgba(0,0,0,0.6)", color: S.textDim,
    fontSize: 11, cursor: "pointer", backdropFilter: "blur(4px)",
  },
  // ── Quick menu ────────────────────────────────────────────────────
  qmBackdrop: { position: "fixed", inset: 0, zIndex: 40, background: "rgba(0,0,0,0.4)" },
  qmPanel: {
    position: "fixed", top: "50%", left: "50%", transform: "translate(-50%,-50%)",
    zIndex: 41, width: 260, padding: 20, borderRadius: 4,
    background: S.bgCard, border: "1px solid rgba(255,255,255,0.08)",
    boxShadow: "0 8px 32px rgba(0,0,0,0.6)", display: "flex", flexDirection: "column", gap: 8,
  },
  qmHeader: { fontSize: 14, fontWeight: 600, color: S.accent, marginBottom: 4 },
  qmBtn: {
    width: "100%", padding: "8px 12px", border: "1px solid rgba(255,255,255,0.08)",
    background: "rgba(255,255,255,0.04)", color: S.text,
    borderRadius: 2, cursor: "pointer", fontSize: 13, textAlign: "left" as const,
  },
  qmDivider: { height: 1, background: "rgba(255,255,255,0.06)", margin: "4px 0" },
  qmLabel: { fontSize: 11, color: S.textDim, marginTop: 4 },
  qmPortBtn: {
    flex: 1, padding: "6px 8px", border: "1px solid rgba(255,255,255,0.08)",
    background: "rgba(255,255,255,0.03)", color: S.textDim,
    borderRadius: 2, cursor: "pointer", fontSize: 12, textAlign: "center" as const,
  },
  // ── Port badges ────────────────────────────────────────────────────
  portBadges: {
    position: "fixed", bottom: 12, right: 12, zIndex: 30,
    display: "flex", gap: 6,
  },
  portBadge: {
    padding: "3px 8px", borderRadius: 2,
    background: "rgba(0,0,0,0.6)", color: S.textDim,
    fontSize: 11, fontFamily: "monospace", backdropFilter: "blur(4px)",
    border: "1px solid rgba(255,255,255,0.06)",
  },
};
