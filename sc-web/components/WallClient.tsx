"use client";

import { useEffect, useState } from "react";
import {
  Box,
  Button,
  Card,
  CardActionArea,
  CardContent,
  CardMedia,
  Chip,
  Container,
  Link,
  Typography,
} from "@mui/material";
import { PlayArrow, LiveTv, WifiOff } from "@mui/icons-material";

// ── The Living Cabinet wall (#762) ─────────────────────────────────────
//
// Public, unauthenticated. Lists every game flagged `public` across all
// servers connected to the gateway, with live-now state. A live game's Play
// button drops the visitor straight into the running session (a free seat
// plays; full sessions land as spectator) — the /r/<roomToken> join flow.

interface WallGame {
  id: string;
  name: string;
  platform: string;
  maxPlayers: number;
  coverUrl?: string | null;
  serverId: string;
  serverName: string;
  serverOnline: boolean;
  live: boolean;
  players: number;
  viewers: number;
  maxSeats: number;
  roomUrl?: string;
}

const POLL_MS = 15_000;

export default function WallClient() {
  const [games, setGames] = useState<WallGame[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch("/api/wall");
        if (!res.ok) throw new Error(`wall unavailable (${res.status})`);
        const data = (await res.json()) as { games: WallGame[] };
        if (!cancelled) {
          setGames(data.games);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "wall unavailable");
      }
    };
    load();
    const timer = setInterval(load, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  return (
    <Container maxWidth="lg" sx={{ py: 4 }}>
      {error && (
        <Typography color="error" sx={{ mb: 2 }}>
          {error}
        </Typography>
      )}

      {games === null && !error ? (
        <Typography color="text.secondary">Loading the wall…</Typography>
      ) : games?.length === 0 ? (
        <Typography color="text.secondary">
          No public games yet. An administrator can flag a game as public from its context menu
          in the library.
        </Typography>
      ) : (
        <Box sx={{ display: "flex", flexWrap: "wrap", gap: 2 }}>
          {games!.map((game) => {
            const playable = game.live && !!game.roomUrl;
            return (
              <Card key={`${game.serverId}:${game.id}`} sx={{ width: 240 }}>
                <CardActionArea
                  component={playable ? Link : "div"}
                  {...(playable ? { href: game.roomUrl, underline: "none" } : {})}
                  disabled={!playable}
                >
                  <Box sx={{ position: "relative" }}>
                    {game.live && game.roomUrl ? (
                      <Box sx={{ height: 150, overflow: "hidden" }}>
                        <WallPreview
                          roomToken={game.roomUrl!.split("/").pop()!.split("?")[0]!}
                          gameId={game.id}
                          serverId={game.serverId}
                          active
                        />
                      </Box>
                    ) : (
                      <CardMedia
                        component="img"
                        height={150}
                        image={game.coverUrl ?? ""}
                        alt={game.name}
                        sx={{ bgcolor: "grey.900", objectFit: "cover" }}
                      />
                    )}
                    <Box sx={{ position: "absolute", top: 8, left: 8 }}>
                      {game.live ? (
                        <Chip
                          size="small"
                          color="success"
                          icon={<LiveTv fontSize="small" />}
                          label={`LIVE · ${game.players}/${game.maxSeats} playing`}
                        />
                      ) : (
                        <Chip
                          size="small"
                          variant="outlined"
                          icon={<WifiOff fontSize="small" />}
                          label={game.serverOnline ? "not live" : "server offline"}
                        />
                      )}
                    </Box>
                  </Box>
                  <CardContent>
                    <Typography variant="subtitle1" noWrap title={game.name}>
                      {game.name}
                    </Typography>
                    <Typography variant="body2" color="text.secondary" noWrap>
                      {game.serverName} · {game.platform}
                    </Typography>
                  </CardContent>
                </CardActionArea>
                <Box sx={{ p: 1.5, pt: 0 }}>
                  <Button
                    fullWidth
                    variant={playable ? "contained" : "outlined"}
                    disabled={!playable}
                    startIcon={<PlayArrow />}
                    component={playable ? Link : "button"}
                    {...(playable ? { href: game.roomUrl, underline: "none" } : {})}
                  >
                    {game.live ? "Play" : game.serverOnline ? "Not live" : "Offline"}
                  </Button>
                </Box>
              </Card>
            );
          })}
        </Box>
      )}
    </Container>
  );
}
