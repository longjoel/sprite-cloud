"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  Box,
  Button,
  Card,
  CardContent,
  Container,
  Stack,
  Typography,
} from "@mui/material";
import WallPreview from "./WallPreview";
import { pickFeatured, type WallGame } from "@/lib/wall-shared";

// ── FeaturedLive — public arcade hero embed ────────────────────────────

export const FEATURE_ROTATE_MS = 60_000;

interface FeaturedLiveProps {
  onFeatured?: (key: string | null) => void;
}

export default function FeaturedLive({ onFeatured }: FeaturedLiveProps) {
  const [games, setGames] = useState<WallGame[] | null>(null);
  const [featuredKey, setFeaturedKey] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/wall");
        if (!res.ok) return;
        const data = (await res.json()) as { games: WallGame[] };
        if (cancelled) return;
        setGames(data.games);
        setFeaturedKey((prev) => pickFeatured(data.games, prev)?.key ?? null);
      } catch {
        // The public wall is optional; the rest of the landing page remains usable.
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!games) return;
    const timer = setInterval(() => {
      setFeaturedKey((prev) => pickFeatured(games, prev)?.key ?? null);
    }, FEATURE_ROTATE_MS);
    return () => clearInterval(timer);
  }, [games]);

  useEffect(() => {
    onFeatured?.(featuredKey);
  }, [featuredKey, onFeatured]);

  const game = games?.find((candidate) => candidate.key === featuredKey) ?? null;

  if (!loaded || !game || !game.roomUrl) return null;

  const roomToken = game.roomUrl.split("/").pop()!.split("?")[0]!;

  return (
    <Container component="section" maxWidth="lg" sx={{ pb: 1 }}>
      <Stack
        direction={{ xs: "column", sm: "row" }}
        spacing={2}
        sx={{
          mb: 2,
          alignItems: { xs: "stretch", sm: "center" },
          justifyContent: "space-between",
        }}
      >
        <Box>
          <Typography variant="h5" component="h2" sx={{ display: "flex", alignItems: "center", gap: 1 }}>
            <Box component="span" aria-hidden="true" sx={{ color: "error.main", fontSize: "1.1em" }}>
              ●
            </Box>
            Live now
          </Typography>
          <Typography variant="body2" color="text.secondary">
            {game.name} · {game.platform} — playing right now on this gateway.
          </Typography>
        </Box>
        <Stack direction="row" spacing={1}>
          <Button component={Link} href={game.watchUrl} variant="outlined">
            Watch
          </Button>
          <Button component={Link} href={game.roomUrl} variant="contained">
            Play
          </Button>
        </Stack>
      </Stack>

      <Card>
        <Box
          component={Link}
          href={game.watchUrl}
          aria-label={`Watch ${game.name} live`}
          sx={{ display: "block", color: "inherit", textDecoration: "none" }}
        >
          <Box sx={{ aspectRatio: "16 / 9", bgcolor: "common.black", overflow: "hidden" }}>
            <WallPreview
              roomToken={roomToken}
              gameId={game.id}
              serverId={game.serverId}
              active
            />
          </Box>
        </Box>
        <CardContent sx={{ display: { xs: "block", sm: "none" } }}>
          <Typography variant="subtitle1" noWrap>
            {game.name}
          </Typography>
          <Typography variant="body2" color="text.secondary">
            {game.platform}
          </Typography>
        </CardContent>
      </Card>
    </Container>
  );
}
