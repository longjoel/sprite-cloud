"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import GamePlayer from "@/components/GamePlayer";

// ── Types ────────────────────────────────────────────────────────────

interface Game {
  id: string; name: string; platform: string;
  cover_url?: string; server_id?: string;
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
  { id: "recent", label: "Recent", filter: () => true }, // placeholder
  { id: "favorites", label: "Favorites", filter: () => false },
  { id: "nes", label: "NES", filter: (g) => g.platform === "NES" },
  { id: "snes", label: "SNES", filter: (g) => g.platform === "SNES" },
  { id: "genesis", label: "Genesis", filter: (g) => g.platform === "Genesis" },
  { id: "gba", label: "GBA", filter: (g) => g.platform === "Game Boy Advance" },
  { id: "gb", label: "GB/GBC", filter: (g) => g.platform === "Game Boy" || g.platform === "Game Boy Color" },
];

// ── Component ─────────────────────────────────────────────────────────

export default function XmbPage() {
  const [focusedCat, setFocusedCat] = useState(0);
  const [focusedSub, setFocusedSub] = useState(0);
  const [focusedGame, setFocusedGame] = useState(0);
  const [games, setGames] = useState<Game[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [playGame, setPlayGame] = useState<{ gameId: string; serverId: string; hostToken?: string; gameName?: string; platform?: string } | null>(null);
  const [fadeIn, setFadeIn] = useState(false);

  const containerRef = useRef<HTMLDivElement>(null);

  // ── Fetch games ──────────────────────────────────────────────────────
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/games?limit=200");
        if (!res.ok) return;
        const data = await res.json();
        setGames(data.games || []);
      } catch { /* fail silently */ }
      setLoaded(true);
    })();
  }, []);

  // ── Filtered games for current sub-category ──────────────────────────
  const sub = SUB_CATEGORIES[focusedSub];
  const filteredGames = games.filter(sub?.filter ?? (() => true));

  // Clamp focused game index
  const safeGameIdx = Math.min(focusedGame, Math.max(0, filteredGames.length - 1));
  const selectedGame = filteredGames[safeGameIdx] ?? null;

  // ── Navigation ───────────────────────────────────────────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (playing) return; // gamepad/keyboard owned by player while playing
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
        case "Escape":
          if (playing) closePlayer();
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [focusedCat, focusedSub, focusedGame, filteredGames, playing, selectedGame]);

  // ── Gamepad polling ──────────────────────────────────────────────────
  useEffect(() => {
    if (playing) return;
    let prevDPad = "";
    const interval = setInterval(() => {
      const pads = navigator.getGamepads?.() ?? [];
      const pad = pads[0]; if (!pad) return;
      const dpad = `${pad.axes[0]?.toFixed(2)},${pad.axes[1]?.toFixed(2)}`;
      if (dpad === prevDPad) return; prevDPad = dpad;
      const ax = pad.axes[0] ?? 0, ay = pad.axes[1] ?? 0;
      if (ax < -0.5) {
        if (focusedSub > 0) setFocusedSub((v) => v - 1);
        else setFocusedCat((v) => Math.max(0, v - 1));
      } else if (ax > 0.5) {
        if (focusedSub < SUB_CATEGORIES.length - 1) setFocusedSub((v) => v + 1);
        else setFocusedCat((v) => Math.min(CATEGORIES.length - 1, v + 1));
      } else if (ay < -0.5) setFocusedGame((v) => Math.max(0, v - 1));
      else if (ay > 0.5) setFocusedGame((v) => Math.min(filteredGames.length - 1, v + 1));
    }, 120);
    return () => clearInterval(interval);
  }, [playing, focusedSub, filteredGames.length]);

  // ── Launch / close ────────────────────────────────────────────────────
  const launchGame = useCallback((game: Game) => {
    if (!game.server_id) return;
    setPlayGame({
      gameId: game.id, serverId: game.server_id,
      gameName: game.name, platform: game.platform,
    });
    setPlaying(true);
    setTimeout(() => setFadeIn(true), 50);
  }, []);

  const closePlayer = useCallback(() => {
    setFadeIn(false);
    setTimeout(() => { setPlaying(false); setPlayGame(null); }, 400);
  }, []);

  // ── Render categories ────────────────────────────────────────────────
  const renderCategories = () => (
    <div style={s.categories}>
      {CATEGORIES.map((cat, i) => (
        <div
          key={cat.id}
          style={{
            ...s.catItem,
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
    </div>
  );

  // ── Render game list ──────────────────────────────────────────────────
  const renderGameList = () => (
    <div style={s.gameList}>
      {filteredGames.map((game, i) => {
        const focused = i === safeGameIdx;
        const firstLetter = game.name.charAt(0).toUpperCase();
        // Show a header when letter changes
        const prevLetter = i > 0 ? filteredGames[i - 1]?.name.charAt(0).toUpperCase() : "";
        const showHeader = firstLetter !== prevLetter;
        return (
          <div key={game.id}>
            {showHeader && <div style={s.letterHeader}>{firstLetter}</div>}
            <div
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
          <div style={{ ...s.playerOverlay, opacity: fadeIn ? 1 : 0 }}>
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
            Press Esc or ○ to close
          </div>
        </>
      ) : (
        <>
          {/* Background ambient */}
          <div style={s.bgGradient} />

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
  catItem: {
    display: "flex", flexDirection: "column", alignItems: "center",
    padding: "6px 20px", borderRadius: 2, cursor: "pointer",
    transition: "all 0.15s ease", color: S.textDim,
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
};
