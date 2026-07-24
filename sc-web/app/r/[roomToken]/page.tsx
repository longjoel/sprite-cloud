"use client";

import { useParams, useSearchParams } from "next/navigation";
import PublicRoomPlayer from "@/components/PublicRoomPlayer";

export default function PublicRoomPage() {
  const { roomToken } = useParams<{ roomToken: string }>();
  const searchParams = useSearchParams();
  return (
    <PublicRoomPlayer
      roomToken={roomToken}
      gameId={searchParams.get("game_id") || ""}
      serverId={searchParams.get("server_id") || ""}
    />
  );
}
