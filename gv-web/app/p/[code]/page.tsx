"use client";

import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import GamePlayer from "@/components/GamePlayer";
import BokehLoading from "@/components/BokehLoading";
import type { StepState } from "@/components/GamePlayerPipeline";

// ── /p/[code] — resolve short code → loading screen → player ────────
//
// Shows a full-screen loading animation with game info while the
// WebRTC connection establishes.  A bokeh particle field reacts to
// real pipeline progress (ICE → Server → Core → Encode → SDP → Media →
// Connected) — particles bloom with each completed stage.  Fades to
// the game when connected.

const COVER_FALLBACK = (
  <svg width="56" height="56" viewBox="0 0 24 24" fill="none" stroke="rgba(56, 189, 248, 0.25)" strokeWidth="1.5">
    <rect x="2" y="3" width="20" height="14" rx="2" />
    <path d="M8 21h8M12 17v4" />
  </svg>
);

export default function ShortCodePage() {
  const { code } = useParams<{ code: string }>();
  const router = useRouter();
  const searchParams = useSearchParams();

  // When loaded from a LAN URL (proxied through gv-server), the Back button
  // should go to the real gv-web origin — not / which would proxy without auth.
  const homeUrl = useMemo(() => {
    if (typeof window === "undefined") return "/";
    try { if (new URLSearchParams(window.location.search).get("route") === "lan") return "https://lngnckr.tech/"; } catch {}
    return "/";
  }, []);

  const [phase, setPhase] = useState<"resolve" | "connecting" | "playing" | "error">("resolve");
  const [fadeOut, setFadeOut] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [gameMeta, setGameMeta] = useState<{
    gameId: string; serverId: string; hostToken?: string; roomToken?: string;
    gameName?: string; platform?: string; coverUrl?: string;
  } | null>(null);

  const [pipeline, setPipeline] = useState<Record<string, StepState>>({});

  const onConnected = useCallback(() => {
    setPhase("playing");
    // Small delay then trigger fade-out of overlay
    setTimeout(() => setFadeOut(true), 600);
  }, []);

  // Resolve short code → get game metadata + start connecting
  useEffect(() => {
    if (!code) return;

    let cancelled = false;
    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(), 12_000);

    (async () => {
      try {
        // Forward any query params (?join etc.) to the resolve endpoint
        const qs = window.location.search;
        const resp = await fetch(`/api/room/resolve/${encodeURIComponent(code)}${qs}`, {
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
          const metaResp = await fetch(`/api/games/${encodeURIComponent(gameId)}`);
          if (metaResp.ok) {
            const metaData = await metaResp.json();
            gameName = metaData.name || "";
            platform = metaData.platform || "";
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

  const handlePipelineChange = useCallback((p: Record<string, StepState>) => {
    setPipeline(p);
  }, []);

  // ── Error ──────────────────────────────────────────────────────────
  if (phase === "error") {
    // Parse diagnostic info from error messages
    const isSessionEnded = error?.includes("session ended") || error?.includes("ended");
    const isWaiting = error?.includes("no active session") || error?.includes("waiting for host");
    const isJoinFail = error?.includes("room join failed");
    const isNotFound = error?.includes("not found") || error?.includes("Not found");
    const isTimedOut = error?.includes("timed out") || error?.includes("Timeout");

    let title = "Connection failed";
    let desc = "";
    let suggestion = "";
    if (isSessionEnded) {
      title = "Session ended";
      desc = "The host stopped streaming or the game session expired.";
      suggestion = "Ask the host to start a new game and share a fresh link.";
    } else if (isWaiting) {
      title = "Waiting for host";
      desc = "No active game session was found. The host may not have started streaming yet.";
      suggestion = "Ask the host to launch the game, then try again.";
    } else if (isJoinFail) {
      title = "Could not join room";
      desc = error || "The room join request failed.";
      suggestion = "Check that the host is still streaming. The game may have ended.";
    } else if (isNotFound) {
      title = "Link not found";
      desc = error || "This share link doesn't match any active game.";
      suggestion = "The link may have expired. Ask the host for a new one.";
    } else if (isTimedOut) {
      title = "Connection timed out";
      desc = error || "The server took too long to respond.";
      suggestion = "Check your internet connection and try again.";
    } else {
      desc = error || "The game couldn't start. The link may have expired.";
      suggestion = "Make sure the host is streaming, then refresh to try again.";
    }

    return (
      <main style={s.error}>
        <div style={s.errorIcon}>!</div>
        <div style={s.errorTitle}>{title}</div>
        <p style={s.errorDesc}>{desc}</p>
        {error && !isSessionEnded && !isNotFound && !isTimedOut && (
          <p style={s.errorDetail}>{error}</p>
        )}
        {suggestion && <p style={s.errorHint}>{suggestion}</p>}
        <div style={s.errorActions}>
          <a href="/" style={s.errorBtn}>← Home</a>
          <button onClick={() => window.location.reload()} style={s.errorBtnRetry}>
            ↻ Retry
          </button>
        </div>
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
            gameName={gameMeta.gameName}
            platform={gameMeta.platform}
            hostToken={gameMeta.hostToken}
            joinToken={gameMeta.roomToken}
            shortCode={code}
            onClose={() => window.location.assign(homeUrl)}
            onConnected={onConnected}
            onFatalError={(msg) => {
              setError(msg);
              setPhase("error");
            }}
            initialPipeline={{ ice: "done", server: "done" }}
            initialStatus="connecting"
            hidePipeline
            onPipelineChange={handlePipelineChange}
          />
        )}

        {/* Loading overlay — lowered z-index so touch gamepad canvas shows through */}
        {showOverlay && (
          <div
            style={{
              ...s.overlay,
              opacity: phase === "playing" ? 0 : 1,
              transition: "opacity 0.5s ease",
              pointerEvents: phase === "playing" ? "none" : "auto",
            }}>
          >
            {/* Bokeh particle field — reacts to real pipeline progress */}
            <BokehLoading
              pipeline={pipeline}
              resolving={phase === "resolve"}
              fadeOut={fadeOut}
              width="100%"
              height="100%"
            />

            {/* Foreground: cover art + title + platform badge */}
            <div style={s.foreground}>
              {gameMeta?.coverUrl ? (
                <img src={gameMeta.coverUrl} alt="" style={s.cover(!!gameMeta.gameName)} />
              ) : (
                <div style={s.coverPlaceholder(!!gameMeta?.gameName)}>{COVER_FALLBACK}</div>
              )}

              {gameMeta?.gameName && (
                <div style={s.meta}>
                  <h1 style={s.title}>{gameMeta.gameName}</h1>
                  {gameMeta.platform && (
                    <span style={s.badge}>{gameMeta.platform}</span>
                  )}
                </div>
              )}

              <p style={s.tagline}>
                {phase === "resolve" ? "Resolving…" : "Loading…"}
              </p>
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
    position: "absolute", inset: 0, zIndex: 5,
    background: "linear-gradient(135deg, #060b14 0%, #0a0e1a 50%, #111827 100%)",
    fontFamily: "system-ui, sans-serif",
  },
  foreground: {
    position: "absolute", inset: 0, zIndex: 1,
    display: "flex", flexDirection: "column", alignItems: "center",
    justifyContent: "center", gap: 20, padding: 32,
    pointerEvents: "none" as const,
  },
  cover: (hasTitle: boolean) => ({
    width: 160, height: 224, objectFit: "cover" as const,
    borderRadius: 2, boxShadow: "0 8px 32px rgba(0,0,0,0.5)",
    border: "1px solid rgba(56, 189, 248, 0.12)",
    marginBottom: hasTitle ? 0 : 8,
  }),
  coverPlaceholder: (hasTitle: boolean) => ({
    width: 160, height: 224, borderRadius: 2,
    background: "linear-gradient(135deg, rgba(56,189,248,0.05), rgba(10,14,26,0.4))",
    border: "1px solid rgba(56, 189, 248, 0.08)",
    display: "flex", alignItems: "center", justifyContent: "center",
    marginBottom: hasTitle ? 0 : 8,
  }),
  meta: { textAlign: "center" as const, maxWidth: 300 },
  title: {
    color: "var(--color-text-primary)", fontSize: 18,
    fontWeight: 600, margin: 0, lineHeight: 1.3,
  },
  badge: {
    display: "inline-block", marginTop: 8, padding: "2px 10px",
    fontSize: 11, fontWeight: 600, color: "var(--color-accent)",
    border: "1px solid rgba(56, 189, 248, 0.18)", borderRadius: 2,
    textTransform: "uppercase" as const, letterSpacing: "0.08em",
  },
  tagline: {
    color: "var(--color-text-secondary)", fontSize: 12,
    margin: 0, opacity: 0.5, letterSpacing: "0.06em",
  },
  error: { minHeight: "100vh", background: "var(--color-sky-deep)", display: "flex", flexDirection: "column" as const, alignItems: "center", justifyContent: "center", gap: 16, padding: 32, fontFamily: "system-ui, sans-serif" },
  errorIcon: { fontSize: "clamp(3rem, 10vw, 6rem)", fontWeight: 700, color: "var(--color-accent)", lineHeight: 1 },
  errorTitle: { fontSize: 14, color: "var(--color-text-primary)", textTransform: "uppercase" as const, letterSpacing: "0.08em", fontWeight: 700 },
  errorDesc: { fontSize: 13, color: "var(--color-text-secondary)", maxWidth: 400, textAlign: "center" as const, lineHeight: 1.6, margin: 0 },
  errorDetail: {
    fontSize: 11, color: "#b8964a", maxWidth: 400, textAlign: "center" as const,
    lineHeight: 1.5, fontFamily: "monospace", background: "rgba(0,0,0,0.3)",
    padding: "8px 14px", borderRadius: 2, margin: 0, wordBreak: "break-all" as const,
  },
  errorHint: { fontSize: 12, color: "var(--color-text-secondary)", maxWidth: 400, textAlign: "center" as const, lineHeight: 1.5, opacity: 0.7, margin: 0 },
  errorActions: { display: "flex", gap: 12, marginTop: 8 },
  errorBtn: {
    padding: "8px 24px", border: "1px solid var(--color-border-default)", color: "var(--color-accent)",
    fontSize: 13, fontFamily: "monospace", textDecoration: "none", textTransform: "uppercase" as const,
    letterSpacing: "0.1em", borderRadius: 2,
  },
  errorBtnRetry: {
    padding: "8px 24px", background: "var(--color-accent)", color: "var(--color-sky-deep)",
    border: "none", fontSize: 13, fontFamily: "monospace", fontWeight: 700, cursor: "pointer",
    textTransform: "uppercase" as const, letterSpacing: "0.1em", borderRadius: 2,
  },
  errorLink: { marginTop: 16, padding: "8px 28px", border: "1px solid var(--color-border-default)", color: "var(--color-accent)", fontSize: 13, fontFamily: "monospace", textDecoration: "none", textTransform: "uppercase" as const, letterSpacing: "0.1em" },
} as const;
