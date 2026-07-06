"use client";

import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useState, type CSSProperties } from "react";
import GamePlayer from "@/components/GamePlayer";
import BokehLoading from "@/components/BokehLoading";
import type { StepState } from "@/components/GamePlayerPipeline";

const COVER_FALLBACK = (
  <svg width="56" height="56" viewBox="0 0 24 24" fill="none" stroke="rgba(56, 189, 248, 0.25)" strokeWidth="1.5">
    <rect x="2" y="3" width="20" height="14" rx="2" />
    <path d="M8 21h8M12 17v4" />
  </svg>
);

export default function PublicRoomPage() {
  const { roomToken } = useParams<{ roomToken: string }>();
  const searchParams = useSearchParams();
  const router = useRouter();

  const gameId = searchParams.get("game_id") || "";
  const serverId = searchParams.get("server_id") || "";

  const [phase, setPhase] = useState<"resolve" | "connecting" | "playing" | "error">("resolve");
  const [fadeOut, setFadeOut] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [gameMeta, setGameMeta] = useState<{ gameName?: string; platform?: string; coverUrl?: string } | null>(null);
  const [pipeline, setPipeline] = useState<Record<string, StepState>>({});

  const onConnected = useCallback(() => {
    setPhase("playing");
    setTimeout(() => setFadeOut(true), 600);
  }, []);

  useEffect(() => {
    if (!roomToken || !gameId || !serverId) {
      setError("missing room info");
      setPhase("error");
      return;
    }

    let cancelled = false;
    (async () => {
      try {
        let gameName = "";
        let platform = "";
        let coverUrl = "";
        const metaResp = await fetch(`/api/games/${encodeURIComponent(gameId)}`);
        if (metaResp.ok) {
          const meta = await metaResp.json();
          gameName = meta.name || "";
          platform = meta.platform || "";
          coverUrl = meta.cover_url || "";
        }
        if (!cancelled) {
          setGameMeta({ gameName, platform, coverUrl });
          setPhase("connecting");
        }
      } catch (e: any) {
        if (!cancelled) {
          setError(e?.message || "network error");
          setPhase("error");
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [roomToken, gameId, serverId]);

  const handlePipelineChange = useCallback((p: Record<string, StepState>) => {
    setPipeline(p);
  }, []);

  if (phase === "error") {
    return (
      <main style={s.error}>
        <div style={s.errorIcon}>!</div>
        <div style={s.errorTitle}>Connection failed</div>
        <p style={s.errorDesc}>{error || "The public session could not be opened."}</p>
        <div style={s.errorActions}>
          <a href="/" style={s.errorBtn}>← Home</a>
          <button onClick={() => window.location.reload()} style={s.errorBtnRetry}>↻ Retry</button>
        </div>
      </main>
    );
  }

  const showOverlay = phase !== "playing" || !fadeOut;

  return (
    <main style={{ width: "100vw", height: "100vh", position: "relative", overflow: "hidden" }}>
      {phase !== "resolve" && roomToken && gameId && serverId && (
        <GamePlayer
          gameId={gameId}
          serverId={serverId}
          gameName={gameMeta?.gameName}
          platform={gameMeta?.platform}
          joinToken={roomToken}
          onClose={() => router.push("/")}
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

      {showOverlay && (
        <div style={{ ...(s.overlay as CSSProperties), opacity: phase === "playing" ? 0 : 1, transition: "opacity 0.5s ease", pointerEvents: phase === "playing" ? "none" : "auto" }}>
          <BokehLoading pipeline={pipeline} resolving={phase === "resolve"} fadeOut={fadeOut} width="100%" height="100%" />
          <div style={s.foreground}>
            {gameMeta?.coverUrl ? (
              <img src={gameMeta.coverUrl} alt="" style={s.cover(!!gameMeta.gameName)} />
            ) : (
              <div style={s.coverPlaceholder(!!gameMeta?.gameName)}>{COVER_FALLBACK}</div>
            )}
            {gameMeta?.gameName && (
              <div style={s.meta}>
                <h1 style={s.title}>{gameMeta.gameName}</h1>
                {gameMeta.platform && <span style={s.badge}>{gameMeta.platform}</span>}
              </div>
            )}
            <p style={s.tagline}>{phase === "resolve" ? "Resolving…" : "Loading…"}</p>
          </div>
        </div>
      )}
    </main>
  );
}

const s: {
  overlay: CSSProperties;
  foreground: CSSProperties;
  cover: (hasTitle: boolean) => CSSProperties;
  coverPlaceholder: (hasTitle: boolean) => CSSProperties;
  meta: CSSProperties;
  title: CSSProperties;
  badge: CSSProperties;
  tagline: CSSProperties;
  error: CSSProperties;
  errorIcon: CSSProperties;
  errorTitle: CSSProperties;
  errorDesc: CSSProperties;
  errorActions: CSSProperties;
  errorBtn: CSSProperties;
  errorBtnRetry: CSSProperties;
} = {
  overlay: {
    position: "absolute", inset: 0, zIndex: 10,
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
    display: "grid", placeItems: "center" as const,
    marginBottom: hasTitle ? 0 : 8,
  }),
  meta: { display: "flex", flexDirection: "column" as const, alignItems: "center", gap: 10 },
  title: { margin: 0, color: "white", fontSize: "clamp(24px, 5vw, 40px)", fontWeight: 800, letterSpacing: "0.01em" },
  badge: { display: "inline-block", padding: "4px 10px", borderRadius: 999, fontSize: 12, letterSpacing: "0.04em", textTransform: "uppercase" as const, color: "#7dd3fc", border: "1px solid rgba(125, 211, 252, 0.25)", background: "rgba(56, 189, 248, 0.08)" },
  tagline: { margin: 0, color: "rgba(255,255,255,0.7)", fontSize: 14, letterSpacing: "0.08em", textTransform: "uppercase" as const },
  error: { minHeight: "100vh", display: "flex", flexDirection: "column" as const, alignItems: "center", justifyContent: "center", gap: 12, background: "var(--color-sky-deep)", color: "var(--color-cloud)", padding: 24 },
  errorIcon: { width: 56, height: 56, display: "grid", placeItems: "center" as const, border: "1px solid rgba(248,113,113,0.35)", color: "#fca5a5", fontSize: 28, fontWeight: 700 },
  errorTitle: { fontSize: 28, fontWeight: 700 },
  errorDesc: { margin: 0, color: "var(--color-cloud-dim)", maxWidth: 520, textAlign: "center" as const },
  errorActions: { display: "flex", gap: 12, marginTop: 8 },
  errorBtn: { padding: "12px 20px", textDecoration: "none", border: "1px solid rgba(56,189,248,0.3)", color: "var(--color-accent)" },
  errorBtnRetry: { padding: "12px 20px", border: "1px solid rgba(56,189,248,0.3)", background: "rgba(56,189,248,0.12)", color: "var(--color-cloud)" },
};
