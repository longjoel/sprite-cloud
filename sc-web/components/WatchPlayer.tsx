"use client";

import { useCallback, useEffect, useState } from "react";
import { Box, Button, Chip, Stack, Typography } from "@mui/material";
import Link from "next/link";
import { useSession } from "next-auth/react";
import WallPreview from "./WallPreview";
import AppHeader from "./fluent/AppHeader";

// ── WatchPlayer — full-screen read-only live viewer for /watch/<slug> ─
//
// Reuses the WallPreview WebRTC path (spectator preview token, viewer
// role, no input). Read-only by construction: no keyboard/gamepad
// handlers, no claim logic — the join is `preview: true` with a stable
// preview client_id.

interface WatchPlayerProps {
  roomToken: string;
  gameId: string;
  serverId: string;
  gameName: string;
  platform: string;
  players: number;
  viewers: number;
  roomUrl: string;
}

export default function WatchPlayer({
  roomToken,
  gameId,
  serverId,
  gameName,
  platform,
  players,
  viewers,
  roomUrl,
}: WatchPlayerProps) {
  const { data: session } = useSession();
  const [connected, setConnected] = useState(false);
  const [copied, setCopied] = useState(false);
  const handleConnected = useCallback(() => setConnected(true), []);

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(t);
  }, [copied]);

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopied(true);
    } catch {
      // clipboard unavailable (non-secure ctx) — ignore
    }
  };

  return (
    <Box
      data-watch-page
      style={{ height: "100dvh", overflow: "hidden" }}
      sx={{
        display: "flex",
        flexDirection: "column",
        bgcolor: "background.default",
        color: "text.primary",
      }}
    >
      <AppHeader
        userName={session?.user?.name || session?.user?.email}
        authenticated={Boolean(session)}
      />

      {/* ── Live video ─────────────────────────────────────────────── */}
      <Box
        data-watch-video-region
        style={{ minHeight: 0 }}
        sx={{
          position: "relative",
          flex: "1 1 0",
          bgcolor: "common.black",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          overflow: "hidden",
        }}
      >
        <WallPreview
          roomToken={roomToken}
          gameId={gameId}
          serverId={serverId}
          active
          onConnected={handleConnected}
        />
        {!connected && (
          <div style={s.badge}>connecting live feed…</div>
        )}
      </Box>

      <Box
        sx={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 2,
          p: 2,
          borderTop: 1,
          borderColor: "divider",
          flex: "0 0 auto",
          flexWrap: "wrap",
        }}
      >
        <Box>
          <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
            <Chip size="small" color="error" label="LIVE" />
            <Typography variant="h6">{gameName}</Typography>
          </Stack>
          <Typography variant="body2" color="text.secondary">
            {platform}
            {" · "}
            {players > 0 ? `${players} playing` : "no players"}
            {viewers > 0 ? ` · ${viewers} watching` : ""}
          </Typography>
        </Box>
        <Stack direction="row" spacing={1}>
          <Button type="button" variant="outlined" onClick={copyLink}>
            {copied ? "✓ Copied" : "Share"}
          </Button>
          <Button component={Link} href={roomUrl} variant="contained">
            ▶ Play
          </Button>
        </Stack>
      </Box>
    </Box>
  );
}

const s: Record<string, React.CSSProperties> = {
  badge: {
    position: "absolute",
    bottom: 12,
    left: 12,
    fontSize: 12,
    color: "#94a3b8",
    background: "rgba(10,15,26,0.8)",
    padding: "4px 10px",
    borderRadius: 999,
  },
  titleBar: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 16,
    padding: "16px 24px",
    borderTop: "1px solid #1e293b",
    flexWrap: "wrap",
  },
  title: {
    fontSize: 20,
    fontWeight: 700,
    display: "flex",
    alignItems: "center",
    gap: 8,
  },
  liveDot: {
    width: 10,
    height: 10,
    borderRadius: "50%",
    background: "#f87171",
    display: "inline-block",
    boxShadow: "0 0 8px #f87171",
  },
  meta: {
    fontSize: 13,
    color: "#94a3b8",
    marginTop: 2,
  },
  actions: {
    display: "flex",
    gap: 10,
    alignItems: "center",
  },
  btn: {
    background: "transparent",
    color: "#e2e8f0",
    border: "1px solid #334155",
    borderRadius: 8,
    padding: "8px 14px",
    cursor: "pointer",
    fontSize: 14,
  },
  playBtn: {
    background: "#38bdf8",
    color: "#0a0f1a",
    textDecoration: "none",
    fontWeight: 700,
    borderRadius: 8,
    padding: "8px 18px",
    fontSize: 14,
  },
};
