"use client";

import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import GamePlayer from "@/components/GamePlayer";

// ── /p/[code] — resolve short code → loading screen → player ────────
//
// Shows a full-screen loading animation with game info while the
// WebRTC connection establishes (~8s ICE gathering). Fades to the
// game when connected.

const LOADING_MESSAGES = [
  "Resolving game…",
  "Loading core…",
  "Establishing connection…",
  "ICE gathering…",
  "Almost ready…",
];

const COVER_FALLBACK = (
  <svg width="56" height="56" viewBox="0 0 24 24" fill="none" stroke="rgba(184, 150, 74, 0.3)" strokeWidth="1.5">
    <rect x="2" y="3" width="20" height="14" rx="2" />
    <path d="M8 21h8M12 17v4" />
  </svg>
);

export default function ShortCodePage() {
  const { code } = useParams<{ code: string }>();

  const [phase, setPhase] = useState<"resolve" | "connecting" | "playing" | "error">("resolve");
  const [messageIdx, setMessageIdx] = useState(0);
  const [fadeOut, setFadeOut] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [gameMeta, setGameMeta] = useState<{
    gameId: string; serverId: string; hostToken?: string; roomToken?: string;
    gameName?: string; platform?: string; coverUrl?: string;
  } | null>(null);

  const onConnected = useCallback(() => {
    setPhase("playing");
    // Small delay then trigger fade-out of overlay
    setTimeout(() => setFadeOut(true), 600);
  }, []);

  // Cycle loading messages
  useEffect(() => {
    if (phase !== "connecting") return;
    const interval = setInterval(() => {
      setMessageIdx((i) => (i + 1) % LOADING_MESSAGES.length);
    }, 1800);
    return () => clearInterval(interval);
  }, [phase]);

  // Resolve short code → get game metadata + start connecting
  useEffect(() => {
    if (!code) return;

    let cancelled = false;
    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(), 12_000);

    (async () => {
      try {
        const resp = await fetch(`/api/room/resolve/${encodeURIComponent(code)}`, {
          signal: abort.signal,
        });
        clearTimeout(timeout);
        if (cancelled) return;

        const data = await resp.json().catch(() => ({}));
        if (!resp.ok) {
          setError(data.error || `Not found (HTTP ${resp.status})`);
          setPhase("error");
          return;
        }

        const gameId = data.game_id as string;
        const serverId = data.server_id as string;
        const hostToken = data.host_token as string | undefined;
        const roomToken = data.room_token as string | undefined;

        // Fetch game metadata for the loading screen (best-effort)
        let gameName = "";
        let platform = "";
        let coverUrl = "";
        try {
          const metaResp = await fetch(`/api/games?search=${encodeURIComponent(gameId)}&limit=1`);
          const metaData = await metaResp.json().catch(() => ({}));
          if (metaData.games?.[0]) {
            gameName = metaData.games[0].name || "";
            platform = metaData.games[0].platform || "";
            coverUrl = metaData.games[0].cover_url || "";
          }
        } catch { /* optional */ }

        setGameMeta({ gameId, serverId, hostToken, roomToken, gameName, platform, coverUrl });
        setPhase("connecting");
      } catch (e: any) {
        clearTimeout(timeout);
        if (cancelled) return;
        setError(e?.name === "AbortError" ? "Request timed out" : e?.message || "Network error");
        setPhase("error");
      }
    })();

    return () => { cancelled = true; clearTimeout(timeout); };
  }, [code]);

  // ── Error ──────────────────────────────────────────────────────────
  if (phase === "error") {
    return (
      <main style={s.error}>
        <div style={s.errorIcon}>!</div>
        <div style={s.errorTitle}>{error || "Something went wrong"}</div>
        <p style={s.errorDesc}>
          {error === "no active session — waiting for host"
            ? "The host has disconnected or the game session expired."
            : "The game couldn't start. The link may have expired."}
        </p>
        <a href="/" style={s.errorLink}>Sprite Cloud</a>
      </main>
    );
  }

  // ── Loading + Player ───────────────────────────────────────────────
  if (phase === "resolve" || phase === "connecting" || phase === "playing") {
    const showOverlay = phase !== "playing" || !fadeOut;

    return (
      <main style={{ width: "100vw", height: "100vh", position: "relative", overflow: "hidden" }}>
        {/* Player underneath — starts connecting immediately */}
        {gameMeta && (
          <GamePlayer
            gameId={gameMeta.gameId}
            serverId={gameMeta.serverId}
            hostToken={gameMeta.hostToken}
            joinToken={gameMeta.roomToken}
            onConnected={onConnected}
            initialPipeline={{ ice: "done", server: "done" }}
            initialStatus="connecting"
          />
        )}

        {/* Loading overlay on top */}
        {showOverlay && (
          <div
            style={{
              ...s.overlay,
              opacity: phase === "playing" ? 0 : 1,
              transition: "opacity 0.5s ease",
              pointerEvents: phase === "playing" ? "none" : "auto",
            }}
          >
            {/* Cover art or fallback */}
            {gameMeta?.coverUrl ? (
              <img src={gameMeta.coverUrl} alt="" style={s.cover(!!gameMeta.gameName)} />
            ) : (
              <div style={s.coverPlaceholder(!!gameMeta?.gameName)}>{COVER_FALLBACK}</div>
            )}

            {/* Game title + platform badge */}
            {gameMeta?.gameName && (
              <div style={s.meta}>
                <h1 style={s.title}>{gameMeta.gameName}</h1>
                {gameMeta.platform && (
                  <span style={s.badge}>{gameMeta.platform}</span>
                )}
              </div>
            )}

            {/* Progress bar */}
            <div style={s.progressWrap}>
              <div style={s.progressTrack}>
                <div style={{
                  ...s.progressFill,
                  width: phase === "connecting" ? `${20 + messageIdx * 18}%` : "100%",
                }} />
              </div>
              <p style={s.message}>
                {phase === "resolve" ? "Resolving…" : LOADING_MESSAGES[messageIdx]}
              </p>
            </div>

            {/* Dots */}
            <div style={s.dots}>
              {LOADING_MESSAGES.map((_, i) => (
                <div
                  key={i}
                  style={{
                    ...s.dot,
                    background: i <= messageIdx ? "var(--color-brass, #b8964a)" : "rgba(255,255,255,0.06)",
                  }}
                />
              ))}
            </div>
          </div>
        )}
      </main>
    );
  }

  return null;
}

// ── Styles ────────────────────────────────────────────────────────────

const s = {
  overlay: {
    position: "absolute", inset: 0, zIndex: 10,
    background: "linear-gradient(135deg, #0a0f14 0%, #1a1410 50%, #0d1117 100%)",
    display: "flex", flexDirection: "column", alignItems: "center",
    justifyContent: "center", gap: 20, padding: 32,
    fontFamily: "system-ui, sans-serif",
  },
  cover: (hasTitle: boolean) => ({
    width: 160, height: 224, objectFit: "cover" as const,
    borderRadius: 12, boxShadow: "0 8px 32px rgba(0,0,0,0.5)",
    border: "1px solid rgba(184, 150, 74, 0.12)",
    marginBottom: hasTitle ? 0 : 8,
  }),
  coverPlaceholder: (hasTitle: boolean) => ({
    width: 160, height: 224, borderRadius: 12,
    background: "linear-gradient(135deg, rgba(184,150,74,0.06), rgba(26,20,16,0.5))",
    border: "1px solid rgba(184,150,74,0.1)",
    display: "flex", alignItems: "center", justifyContent: "center",
    marginBottom: hasTitle ? 0 : 8,
  }),
  meta: { textAlign: "center" as const, maxWidth: 300 },
  title: {
    color: "var(--color-cream, #e8dcc8)", fontSize: 18,
    fontWeight: 600, margin: 0, lineHeight: 1.3,
  },
  badge: {
    display: "inline-block", marginTop: 8, padding: "2px 10px",
    fontSize: 11, fontWeight: 600, color: "var(--color-brass, #b8964a)",
    border: "1px solid rgba(184,150,74,0.2)", borderRadius: 4,
    textTransform: "uppercase" as const, letterSpacing: "0.08em",
  },
  progressWrap: { width: 240, display: "flex", flexDirection: "column" as const, gap: 10 },
  progressTrack: { width: "100%", height: 3, background: "rgba(255,255,255,0.06)", borderRadius: 2, overflow: "hidden" },
  progressFill: { height: "100%", background: "linear-gradient(90deg, var(--color-brass, #b8964a), var(--color-cream, #e8dcc8))", borderRadius: 2, transition: "width 0.8s ease" },
  message: { color: "var(--color-muted, #b8a888)", fontSize: 13, margin: 0, textAlign: "center" as const, opacity: 0.65 },
  dots: { display: "flex", gap: 6 },
  dot: { width: 6, height: 6, borderRadius: "50%", transition: "background 0.4s ease" },
  error: { minHeight: "100vh", background: "var(--color-mahogany, #1a1410)", display: "flex", flexDirection: "column" as const, alignItems: "center", justifyContent: "center", gap: 16, padding: 32, fontFamily: "system-ui, sans-serif" },
  errorIcon: { fontSize: "clamp(3rem, 10vw, 6rem)", fontWeight: 700, color: "var(--color-brass, #b8964a)", lineHeight: 1 },
  errorTitle: { fontSize: 14, color: "var(--color-cream, #e8dcc8)", textTransform: "uppercase" as const, letterSpacing: "0.08em" },
  errorDesc: { fontSize: 12, color: "var(--color-muted, #b8a888)", maxWidth: 360, textAlign: "center" as const, lineHeight: 1.6 },
  errorLink: { marginTop: 16, padding: "8px 28px", border: "1px solid var(--color-bamboo, #4a3a28)", color: "var(--color-muted, #b8a888)", fontSize: 13, fontFamily: "monospace", textDecoration: "none", textTransform: "uppercase" as const, letterSpacing: "0.1em" },
} as const;
