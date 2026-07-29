"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import GamePlayer from "@/components/GamePlayer";
import BokehLoading from "@/components/BokehLoading";
import type { StepState } from "@/components/GamePlayerPipeline";
import type { PlayerCapabilities } from "@/lib/capabilities";

// ── Shared player launch/loading/error shell ─────────────────────────
//
// Consumed by short-code (/p/:code), private room (/r/:roomToken), and
// LAN proxy routes. Handles resolve → connecting → playing → error in
// one place instead of duplicating the orchestration across every entry
// point.
//
// Reduced-motion users receive a static gradient during loading;
// Bokeh particle animation runs only when motion is allowed.

const COVER_FALLBACK = (
  <svg width="56" height="56" viewBox="0 0 24 24" fill="none" stroke="rgba(56, 189, 248, 0.25)" strokeWidth="1.5">
    <rect x="2" y="3" width="20" height="14" rx="2" />
    <path d="M8 21h8M12 17v4" />
  </svg>
);

export interface ResolvedSession {
  gameId: string;
  serverId: string;
  hostToken?: string;
  roomToken?: string;
  capabilities?: PlayerCapabilities;
  seat?: number;
  gameName?: string;
  platform?: string;
  coverUrl?: string;
}

export interface PlayerShellProps {
  /** Back-navigation URL when the player closes */
  homeUrl: string;
  /**
   * Promise that resolves the session metadata. Called once on mount.
   * May throw — errors become friendly diagnostic messages.
   */
  resolvePlayer: (signal: AbortSignal) => Promise<ResolvedSession>;
  /**
   * Initial pipeline state injected into GamePlayer. For guest/room
   * entry points that bypass the earlier RTC steps.
   */
  initialPipeline?: Record<string, StepState>;
  /** If true, suppress GamePlayer's own pipeline UI (shell owns the overlay). */
  hidePipeline?: boolean;
}

export default function PlayerShell({
  homeUrl,
  resolvePlayer,
  initialPipeline,
  hidePipeline = true,
}: PlayerShellProps) {
  const [phase, setPhase] = useState<"resolve" | "connecting" | "playing" | "error">("resolve");
  const [fadeOut, setFadeOut] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [gameMeta, setGameMeta] = useState<ResolvedSession | null>(null);
  const [pipeline, setPipeline] = useState<Record<string, StepState>>({});

  const onConnected = useCallback(() => {
    setPhase("playing");
    setTimeout(() => setFadeOut(true), 600);
  }, []);

  // ── Resolve session on mount ──────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(), 15_000);

    (async () => {
      try {
        const meta = await resolvePlayer(abort.signal);
        clearTimeout(timeout);
        if (cancelled) return;
        setGameMeta(meta);
        setPhase("connecting");
      } catch (e: any) {
        clearTimeout(timeout);
        if (cancelled) return;
        setError(e?.name === "AbortError" ? "Request timed out" : e?.message || "Network error");
        setPhase("error");
      }
    })();

    return () => { cancelled = true; clearTimeout(timeout); };
  }, [resolvePlayer]);

  const handlePipelineChange = useCallback((p: Record<string, StepState>) => {
    setPipeline(p);
  }, []);

  // ── Ctrl+G — toggle touch gamepad ─────────────────────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key === "g") {
        e.preventDefault();
        const tg = (window as any).__scTouchGamepad;
        if (tg?.toggle) { try { tg.toggle(); } catch {} }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // ── Error display ─────────────────────────────────────────────────
  if (phase === "error") {
    const msg = error || "";
    const isSessionEnded = msg.includes("session ended") || msg.includes("ended");
    const isWaiting = msg.includes("no active session") || msg.includes("waiting for host");
    const isJoinFail = msg.includes("room join failed");
    const isNotFound = msg.includes("not found") || msg.includes("Not found");
    const isTimedOut = msg.includes("timed out") || msg.includes("Timeout");

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
      desc = msg || "The room join request failed.";
      suggestion = "Check that the host is still streaming. The game may have ended.";
    } else if (isNotFound) {
      title = "Link not found";
      desc = msg || "This share link doesn't match any active game.";
      suggestion = "The link may have expired. Ask the host for a new one.";
    } else if (isTimedOut) {
      title = "Connection timed out";
      desc = msg || "The server took too long to respond.";
      suggestion = "Check your internet connection and try again.";
    } else {
      desc = msg || "The game couldn't start. The link may have expired.";
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

  // ── Loading overlay + GamePlayer ───────────────────────────────────
  const showOverlay = phase !== "playing" || !fadeOut;

  return (
    <main style={{ width: "100vw", height: "100vh", position: "relative", overflow: "hidden" }}>
      {gameMeta && (
        <GamePlayer
          gameId={gameMeta.gameId}
          serverId={gameMeta.serverId}
          gameName={gameMeta.gameName}
          platform={gameMeta.platform}
          hostToken={gameMeta.hostToken}
          joinToken={gameMeta.roomToken}
          capabilities={gameMeta.capabilities}
          seat={gameMeta.seat}
          onClose={() => window.location.assign(homeUrl)}
          onConnected={onConnected}
          onFatalError={(msg) => { setError(msg); setPhase("error"); }}
          initialPipeline={initialPipeline}
          hidePipeline={hidePipeline}
          onPipelineChange={handlePipelineChange}
        />
      )}

      {showOverlay && (
        <div
          style={{
            ...s.overlay,
            opacity: phase === "playing" ? 0 : 1,
            transition: "opacity 0.5s ease",
            pointerEvents: phase === "playing" ? "none" : "auto",
          }}>
          <BokehLoading
            pipeline={pipeline}
            resolving={phase === "resolve"}
            fadeOut={fadeOut}
            width="100%"
            height="100%"
          />

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

// ── Styles ────────────────────────────────────────────────────────────

const s = {
  overlay: {
    position: "absolute", inset: 0, zIndex: 5,
    background: "linear-gradient(135deg, #060b14 0%, #0a0e1a 50%, #111827 100%)",
    fontFamily: "system-ui, sans-serif",
  } as const,
  foreground: {
    position: "absolute", inset: 0, zIndex: 1,
    display: "flex", flexDirection: "column", alignItems: "center",
    justifyContent: "center", gap: 20, padding: 32,
    pointerEvents: "none",
  } as const,
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
  meta: { textAlign: "center", maxWidth: 300 } as const,
  title: {
    color: "var(--color-text-primary)", fontSize: 18,
    fontWeight: 600, margin: 0, lineHeight: 1.3,
  } as const,
  badge: {
    display: "inline-block", marginTop: 8, padding: "2px 10px",
    fontSize: 11, fontWeight: 600, color: "var(--color-accent)",
    border: "1px solid rgba(56, 189, 248, 0.18)", borderRadius: 2,
    textTransform: "uppercase", letterSpacing: "0.08em",
  } as const,
  tagline: {
    color: "var(--color-text-secondary)", fontSize: 12,
    margin: 0, opacity: 0.5, letterSpacing: "0.06em",
  } as const,
  error: { minHeight: "100vh", background: "var(--color-sky-deep)", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 16, padding: 32, fontFamily: "system-ui, sans-serif" } as const,
  errorIcon: { fontSize: "clamp(3rem, 10vw, 6rem)", fontWeight: 700, color: "var(--color-accent)", lineHeight: 1 } as const,
  errorTitle: { fontSize: 14, color: "var(--color-text-primary)", textTransform: "uppercase", letterSpacing: "0.08em", fontWeight: 700 } as const,
  errorDesc: { fontSize: 13, color: "var(--color-text-secondary)", maxWidth: 400, textAlign: "center", lineHeight: 1.6, margin: 0 } as const,
  errorDetail: {
    fontSize: 11, color: "#b8964a", maxWidth: 400, textAlign: "center",
    lineHeight: 1.5, fontFamily: "monospace", background: "rgba(0,0,0,0.3)",
    padding: "8px 14px", borderRadius: 2, margin: 0, wordBreak: "break-all",
  } as const,
  errorHint: { fontSize: 12, color: "var(--color-text-secondary)", maxWidth: 400, textAlign: "center", lineHeight: 1.5, opacity: 0.7, margin: 0 } as const,
  errorActions: { display: "flex", gap: 12, marginTop: 8 } as const,
  errorBtn: {
    padding: "8px 24px", border: "1px solid var(--color-border-default)", color: "var(--color-accent)",
    fontSize: 13, fontFamily: "monospace", textDecoration: "none", textTransform: "uppercase",
    letterSpacing: "0.1em", borderRadius: 2,
  } as const,
  errorBtnRetry: {
    padding: "8px 24px", background: "var(--color-accent)", color: "var(--color-sky-deep)",
    border: "none", fontSize: 13, fontFamily: "monospace", fontWeight: 700, cursor: "pointer",
    textTransform: "uppercase", letterSpacing: "0.1em", borderRadius: 2,
  } as const,
} as const;
