"use client";

import { useParams, useSearchParams } from "next/navigation";
import RoomInvitePlayer from "@/components/RoomInvitePlayer";

export default function RoomInvitePage() {
  const { roomToken } = useParams<{ roomToken: string }>();
  const searchParams = useSearchParams();
  return (
    <RoomInvitePlayer
      roomToken={roomToken}
      gameId={searchParams.get("game_id") || ""}
      serverId={searchParams.get("server_id") || ""}
    />
  );
}
