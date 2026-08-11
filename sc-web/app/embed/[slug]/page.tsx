import NextLink from "next/link";
import { Box, Link, Typography } from "@mui/material";
import { getWallGames } from "@/lib/wall";
import EmbedPlayer from "@/components/EmbedPlayer";

// ── /embed/[slug] — iframe-friendly live video embed (#781) ───────────
//
// Chrome-free page designed to be iframed on third-party sites
// (frame-ancestors * via next.config header override). Shows only the
// game's live video; offline slugs render a compact placeholder. Same
// fail-closed resolution as /watch: public wall data only, read-only
// spectator preview (no input, no player-seat consumption).

interface EmbedPageProps {
  params: Promise<{ slug: string }>;
}

async function resolveSlug(slug: string) {
  const games = await getWallGames();
  return (
    games.find((g) => g.slug === slug && g.live && g.roomUrl) ??
    games.find((g) => g.slug === slug) ??
    null
  );
}

export default async function EmbedPage({ params }: EmbedPageProps) {
  const { slug } = await params;
  const game = await resolveSlug(slug);

  if (!game || !game.live || !game.roomUrl) {
    return (
      <Box sx={{ position: "fixed", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 1, bgcolor: "background.default", color: "text.secondary", p: 2 }}>
        <Typography variant="body2">{game?.name ?? "This game"} isn&apos;t live right now.</Typography>
        <Link component={NextLink} href="/" underline="hover">Back to the arcade</Link>
      </Box>
    );
  }

  const roomToken = new URL(game.roomUrl, "https://sprite-cloud.com").pathname
    .split("/").pop()!.split("?")[0]!;

  return (
    <Box sx={{ position: "fixed", inset: 0, bgcolor: "#000" }}>
      <EmbedPlayer
        roomToken={roomToken}
        gameId={game.id}
        serverId={game.serverId}
      />
    </Box>
  );
}
