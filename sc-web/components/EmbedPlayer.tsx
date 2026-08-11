"use client";

import { Box } from "@mui/material";
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
    <Box sx={{ position: "fixed", inset: 0, bgcolor: "#000" }}>
      <WallPreview
        roomToken={roomToken}
        gameId={gameId}
        serverId={serverId}
        active
      />
    </Box>
  );
}
