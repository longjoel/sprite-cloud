"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import GamePlayer from "@/components/GamePlayer";

// ── Types ────────────────────────────────────────────────────────────

interface Game {
  id: string;
  name: string;
  platform: string;
  maxPlayers?: number;
  serverId?: string;
  server_id?: string;
  cover_url?: string;
  pinned?: boolean;
}

interface Category {
  id: string; label: string; icon: string;
}

interface SubCategory {
  id: string; label: string; filter: (g: Game) => boolean;
}

// ── Constants ────────────────────────────────────────────────────────

const CATEGORIES: Category[] = [
  { id: "games", label: "Game", icon: "▶" },
  { id: "friends", label: "Friends", icon: "🎮" },
  { id: "settings", label: "Settings", icon: "⚙" },
  { id: "users", label: "Users", icon: "👤" },
];

const SUB_CATEGORIES: SubCategory[] = [
  { id: "all", label: "All", filter: () => true },
  { id: "nes", label: "NES", filter: (g) => g.platform === "NES" },
  { id: "snes", label: "SNES", filter: (g) => g.platform === "SNES" },
  { id: "genesis", label: "Genesis", filter: (g) => g.platform === "Genesis" },
  { id: "gba", label: "GBA", filter: (g) => g.platform === "Game Boy Advance" },
  { id: "gb", label: "GB/GBC", filter: (g) => g.platform === "Game Boy" || g.platform === "Game Boy Color" },
];

// ── Component ─────────────────────────────────────────────────────────

export default function XmbPage() {
  const router = useRouter();
  const { data: session, status } = useSession();

  const [focusedCat, setFocusedCat] = useState(0);
  const [focusedSub, setFocusedSub] = useState(0);
  const [focusedGame, setFocusedGame] = useState(0);
  const [games, setGames] = useState<Game[]>([]);
  const [search, setSearch] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [bootstrap, setBootstrap] = useState<{
    servers: Array<{ id: string; name: string; gameCount: number }>;
    library: { totalGames: number; pinnedCount: number } | null;
    ice: { stunConfigured: boolean; turnConfigured: boolean; transportPolicy: string };
  } | null>(null);
  const [playing, setPlaying] = useState(false);
  const [playGame, setPlayGame] = useState<{ gameId: string; serverId: string; hostToken?: string; gameName?: string; platform?: string } | null>(null);
  const [fadeIn, setFadeIn] = useState(false);
  const [kbdPort, setKbdPort] = useState(0); // 0 = auto, 1-4 = fixed port
  const [isMobile, setIsMobile] = useState(false);

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
        if (dx < 0) setFocusedCat((v) => Math.min(CATEGORIES.length - 1, v + 1));
        else setFocusedCat((v) => Math.max(0, v - 1));
      }
    };
    window.addEventListener("touchstart", onTouchStart, { passive: true });
    window.addEventListener("touchend", onTouchEnd, { passive: true });
    return () => { window.removeEventListener("touchstart", onTouchStart); window.removeEventListener("touchend", onTouchEnd); };
  }, [isMobile]);

  // ── Fetch games ──────────────────────────────────────────────────────
  useEffect(() => {
    (async () => {
      try {
        const query = search ? `?search=${encodeURIComponent(search)}&limit=200&pins_first=true` : "?limit=200&pins_first=true";
        const res = await fetch(`/api/games${query}`);
        if (!res.ok) return;
        const data = await res.json();
        setGames(data.games || []);
      } catch { /* fail silently */ }
      setLoaded(true);
    })();
  }, [search]);

  // ── Fetch bootstrap (once, when authenticated) ───────────────────
  useEffect(() => {
    if (status !== "authenticated") return;
    (async () => {
      try {
        const res = await fetch("/api/client/bootstrap");
        if (!res.ok) return;
        const data = await res.json();
        setBootstrap({ servers: data.servers || [], library: data.library, ice: data.ice });
      } catch { /* fail silently */ }
    })();
  }, [status]);

  // ── Filtered games for current sub-category ──────────────────────────
  const sub = SUB_CATEGORIES[focusedSub];
  const filteredGames = games.filter(sub?.filter ?? (() => true));

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
      switch (e.key) {
        case "ArrowLeft":
          if (focusedSub > 0) setFocusedSub((v) => v - 1);
          else { e.preventDefault(); setFocusedCat((v) => Math.max(0, v - 1)); }
          break;
        case "ArrowRight":
          if (focusedSub < SUB_CATEGORIES.length - 1) setFocusedSub((v) => v + 1);
          else { e.preventDefault(); setFocusedCat((v) => Math.min(CATEGORIES.length - 1, v + 1)); }
          break;
        case "ArrowUp":
          e.preventDefault();
          setFocusedGame((v) => Math.max(0, v - 1));
          break;
        case "ArrowDown":
          e.preventDefault();
          setFocusedGame((v) => Math.min(filteredGames.length - 1, v + 1));
          break;
        case "Enter":
          if (focusedCat === 0 && selectedGame) {
            launchGame(selectedGame);
          }
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [focusedCat, focusedSub, focusedGame, filteredGames, playing, selectedGame]);

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
      // XMB navigation
      if (ax < -0.5) {
        if (focusedSub > 0) setFocusedSub((v) => v - 1);
        else setFocusedCat((v) => Math.max(0, v - 1));
      } else if (ax > 0.5) {
        if (focusedSub < SUB_CATEGORIES.length - 1) setFocusedSub((v) => v + 1);
        else setFocusedCat((v) => Math.min(CATEGORIES.length - 1, v + 1));
      } else if (ay < -0.5) setFocusedGame((v) => Math.max(0, v - 1));
      else if (ay > 0.5) setFocusedGame((v) => Math.min(filteredGames.length - 1, v + 1));
      // A button (0): launch
      else if (pad.buttons[0]?.pressed && focusedCat === 0 && selectedGame) {
        prevState = "";
        launchGame(selectedGame);
      }
    }, 120);
    return () => clearInterval(interval);
  }, [playing, focusedSub, filteredGames.length, focusedCat, selectedGame]);

  // ── Launch / close ────────────────────────────────────────────────────
  const launchGame = useCallback((game: Game) => {
    const sid = game.serverId || game.server_id;
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
      {CATEGORIES.map((cat, i) => (
        <div
          key={cat.id}
          style={{
            ...s.catItem,
            ...(isMobile ? s.catItemMobile : {}),
            ...(i === focusedCat ? s.catFocused : {}),
          }}
          onClick={() => setFocusedCat(i)}
          title={cat.label}
        >
          <span style={s.catIcon}>{cat.icon}</span>
          <span style={s.catLabel}>{cat.label}</span>
        </div>
      ))}
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
      <input
        type="text"
        placeholder="Search…"
        value={search}
        onChange={(e) => { setSearch(e.target.value); setFocusedGame(0); }}
        style={s.searchInput}
        onClick={(e) => e.stopPropagation()}
      />
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
              {game.cover_url ? (
                <img src={game.cover_url} alt="" style={s.cover} />
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
      {!loaded && <div style={s.loading}>Loading…</div>}
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

          {/* Server status bar (from bootstrap) */}
          {bootstrap && bootstrap.servers.length > 0 && (
            <div style={s.statusBar}>
              <span style={s.statusLabel}>
                {bootstrap.servers[0].name}
              </span>
              <span style={s.statusMeta}>
                {bootstrap.library?.totalGames ?? 0} games
                {bootstrap.library?.pinnedCount ? ` · ${bootstrap.library.pinnedCount} pinned` : ""}
              </span>
              {!bootstrap.ice.turnConfigured && (
                <span style={s.statusWarn}>⚠ relay inactive</span>
              )}
            </div>
          )}

          {/* Main XMB layout */}
          <div style={s.xmbBody}>
            {focusedCat === 0 && (
              <>
                {renderSubCategories()}
                {renderGameList()}
              </>
            )}
            {focusedCat === 1 && (
              <div style={s.placeholder}>Friends — coming soon</div>
            )}
            {focusedCat === 2 && (
              <div style={s.placeholder}>Settings — use dashboard</div>
            )}
            {focusedCat === 3 && (
              <div style={s.placeholder}>Users — coming soon</div>
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
    background: S.bg, overflow: "hidden", fontFamily: "system-ui, sans-serif",
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
  xmbBody: {
    position: "absolute", inset: 0, bottom: 72, zIndex: 1,
    display: "flex", flexDirection: "column", overflow: "hidden",
  },
  categories: {
    position: "absolute", bottom: 0, left: 0, right: 0, zIndex: 10,
    height: 68, display: "flex", alignItems: "center", justifyContent: "center",
    gap: 4, background: "rgba(0,0,0,0.6)", backdropFilter: "blur(12px)",
    borderTop: "1px solid rgba(255,255,255,0.04)",
  },
  categoriesMobile: {
    height: 56, gap: 0,
  },
  catItem: {
    display: "flex", flexDirection: "column", alignItems: "center",
    padding: "6px 20px", borderRadius: 2, cursor: "pointer",
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
    marginLeft: "auto", padding: "4px 10px", border: "1px solid rgba(255,255,255,0.08)",
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
