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

    (async () => {
      try {
        const resp = await fetch(`/api/room/resolve/${encodeURIComponent(code)}`);
        if (!resp.ok) {
          const data = await resp.json().catch(() => ({}));
          setState({ loading: false, error: data.error || "Not found", gameId: null, serverId: null, hostToken: null, roomToken: null });
          return;
        }
        const data = await resp.json();
        setState({ loading: false, error: null, gameId: data.game_id, serverId: data.server_id, hostToken: data.host_token, roomToken: data.room_token || null });
      } catch (e: any) {
        setState({ loading: false, error: e?.message || "Network error", gameId: null, serverId: null, hostToken: null, roomToken: null });
      }
    })();
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
      <main style={{ minHeight: "100vh", background: "#000", display: "flex", alignItems: "center", justifyContent: "center", flexDirection: "column", gap: 16 }}>
        <p style={{ color: "#e55", fontFamily: "system-ui" }}>{state.error || "Invalid link"}</p>
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
