"use client";

import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import GamePlayer from "@/components/GamePlayer";

// ── /p/[code] — resolve short code → render player directly ─────────
//
// Fetches the short code resolution client-side so the browser URL
// stays clean (/p/AGFDOY) throughout the session.

export default function ShortCodePage() {
  const params = useParams<{ code: string }>();
  const code = params.code;

  const [state, setState] = useState<{
    loading: boolean;
    error: string | null;
    gameId: string | null;
    serverId: string | null;
    hostToken: string | null;
    roomToken: string | null;
  }>({ loading: true, error: null, gameId: null, serverId: null, hostToken: null, roomToken: null });

  useEffect(() => {
    if (!code) return;

    let cancelled = false;

    (async () => {
      // Timeout after 8 seconds — prevent infinite spinner
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);

      try {
        const resp = await fetch(`/api/room/resolve/${encodeURIComponent(code)}`, {
          signal: controller.signal,
        });

        clearTimeout(timeout);
        if (cancelled) return;

        const data = await resp.json().catch(() => ({}));

        if (!resp.ok) {
          setState({
            loading: false,
            error: data.error || `Not found (HTTP ${resp.status})`,
            gameId: null,
            serverId: null,
            hostToken: null,
            roomToken: null,
          });
          return;
        }

        setState({
          loading: false,
          error: null,
          gameId: data.game_id,
          serverId: data.server_id,
          hostToken: data.host_token,
          roomToken: data.room_token || null,
        });
      } catch (e: any) {
        clearTimeout(timeout);
        if (cancelled) return;

        const msg = e?.name === "AbortError"
          ? "Request timed out — the server may be down"
          : e?.message || "Network error";

        setState({
          loading: false,
          error: msg,
          gameId: null,
          serverId: null,
          hostToken: null,
          roomToken: null,
        });
      }
    })();

    return () => { cancelled = true; };
  }, [code]);

  if (state.loading) {
    return (
      <main style={{ minHeight: "100vh", background: "#000", display: "flex", alignItems: "center", justifyContent: "center" }}>
        <p style={{ color: "#888", fontFamily: "system-ui" }}>Resolving…</p>
      </main>
    );
  }

  if (state.error || !state.gameId || !state.serverId) {
    return (
      <main style={{ minHeight: "100vh", background: "var(--color-mahogany, #1a1410)", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 16, padding: 32 }}>
        <div style={{ fontSize: "clamp(3rem, 10vw, 6rem)", fontWeight: 700, color: "var(--color-brass, #b8964a)", lineHeight: 1 }}>404</div>
        <div style={{ fontSize: 14, color: "var(--color-cream, #e8dcc8)", textTransform: "uppercase", letterSpacing: "0.08em" }}>
          {state.error || "Invalid link"}
        </div>
        <div style={{ fontSize: 12, color: "var(--color-muted, #b8a888)", maxWidth: 360, textAlign: "center", lineHeight: 1.6 }}>
          {state.error === "no active session — waiting for host"
            ? "The host has disconnected or the game session expired. Ask the host to start a new game."
            : "This short code doesn't match any active game. The link may have expired."}
        </div>
        <a href="/" style={{ marginTop: 16, padding: "6px 24px", border: "1px solid var(--color-bamboo, #4a3a28)", color: "var(--color-muted, #b8a888)", fontSize: 12, fontFamily: "monospace", textDecoration: "none", textTransform: "uppercase", letterSpacing: "0.1em" }}>
          Games Vault
        </a>
      </main>
    );
  }

  return (
    <GamePlayer
      gameId={state.gameId}
      serverId={state.serverId}
      hostToken={state.hostToken ?? undefined}
      joinToken={state.roomToken ?? undefined}
      initialPipeline={{ ice: "done", server: "done", game: "done", worker: "active" }}
      initialStatus="connecting"
    />
  );
}
