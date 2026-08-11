"use client";

import { useMemo } from "react";
import { useParams, useSearchParams } from "next/navigation";
import PlayerShell from "@/components/PlayerShell";
import type { PlayerCapabilities } from "@/lib/capabilities";

export default function ShortCodePage() {
  const { code } = useParams<{ code: string }>();
  const searchParams = useSearchParams();
  const isLanProxy = searchParams.get("route") === "lan";
  const homeUrl = isLanProxy ? "https://sprite-cloud.com/" : "/";

  const resolvePlayer = useMemo(
    () => async (signal: AbortSignal) => {
      const qs = window.location.search;
      const resp = await fetch(`/api/room/resolve/${encodeURIComponent(code)}${qs}`, { signal });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        throw new Error(data.error || `Not found (HTTP ${resp.status})`);
      }

      let gameName = "";
      let platform = "";
      try {
        const detailResponse = await fetch(`/api/games/${encodeURIComponent(data.game_id)}`);
        if (detailResponse.ok) {
          const detail = await detailResponse.json();
          gameName = detail.name || "";
          platform = detail.platform || "";
        }
      } catch { /* metadata is available only through the LAN server */ }

      return {
        gameId: data.game_id as string,
        serverId: data.server_id as string,
        hostToken: data.host_token as string | undefined,
        roomToken: data.room_token as string | undefined,
        capabilities: data.capabilities as PlayerCapabilities | undefined,
        seat: data.seat as number | undefined,
        gameName,
        platform,
      };
    },
    [code],
  );

  return (
    <PlayerShell
      homeUrl={homeUrl}
      isLanProxy={isLanProxy}
      resolvePlayer={resolvePlayer}
    />
  );
}
