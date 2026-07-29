"use client";

import { useMemo } from "react";
import { useParams, useSearchParams } from "next/navigation";
import PlayerShell from "@/components/PlayerShell";

export default function RoomInvitePage() {
  const { roomToken } = useParams<{ roomToken: string }>();
  const searchParams = useSearchParams();
  const gameId = searchParams.get("game_id") || "";
  const serverId = searchParams.get("server_id") || "";

  const resolvePlayer = useMemo(
    () => async (_signal: AbortSignal) => {
      if (!roomToken || !gameId || !serverId) {
        throw new Error("missing room info");
      }

      let gameName = "";
      let platform = "";
      try {
        const response = await fetch(`/api/games/${encodeURIComponent(gameId)}`);
        if (response.ok) {
          const detail = await response.json();
          gameName = detail.name || "";
          platform = detail.platform || "";
        }
      } catch { /* cloud guests use metadata-free fallback UI */ }

      return { gameId, serverId, roomToken, gameName, platform };
    },
    [roomToken, gameId, serverId],
  );

  return (
    <PlayerShell
      homeUrl="/"
      resolvePlayer={resolvePlayer}
      initialPipeline={{ rtc: "done" }}
    />
  );
}
