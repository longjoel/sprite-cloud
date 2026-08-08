import Link from "next/link";
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
      <div style={s.offline}>
        <span>{game?.name ?? "This game"} isn&apos;t live right now.</span>
        <Link href="/" style={s.link}>Back to the arcade</Link>
      </div>
    );
  }

  const roomToken = new URL(game.roomUrl, "https://sprite-cloud.com").pathname
    .split("/").pop()!.split("?")[0]!;

  return (
    <div style={s.page}>
      <EmbedPlayer
        roomToken={roomToken}
        gameId={game.id}
        serverId={game.serverId}
      />
    </div>
  );
}

const s: Record<string, React.CSSProperties> = {
  page: {
    position: "fixed",
    inset: 0,
    background: "#000",
  },
  offline: {
    position: "fixed",
    inset: 0,
    display: "flex",
    flexDirection: "column",
    gap: 8,
    alignItems: "center",
    justifyContent: "center",
    background: "#0a0f1a",
    color: "#94a3b8",
    fontFamily: "system-ui, sans-serif",
    fontSize: 14,
  },
  link: {
    color: "#38bdf8",
    textDecoration: "none",
    fontSize: 13,
  },
};
