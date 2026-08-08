"use client";

import WallPreview from "./WallPreview";

// ── EmbedPlayer — bare live video for /embed/<slug> iframes (#781) ───
//
// Fills the viewport. No chrome, no controls of its own — the video
// element itself is interactive only in the sense that it displays the
// stream (read-only; the join is a spectator preview token).

interface EmbedPlayerProps {
  roomToken: string;
  gameId: string;
  serverId: string;
}

export default function EmbedPlayer({ roomToken, gameId, serverId }: EmbedPlayerProps) {
  return (
    <div style={{ position: "fixed", inset: 0, background: "#000" }}>
      <WallPreview
        roomToken={roomToken}
        gameId={gameId}
        serverId={serverId}
        active
      />
    </div>
  );
}
