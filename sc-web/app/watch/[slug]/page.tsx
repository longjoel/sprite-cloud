import type { Metadata } from "next";
import Link from "next/link";
import { getWallGames, slugify } from "@/lib/wall";
import WatchPlayer from "@/components/WatchPlayer";

// ── /watch/[slug] — public, shareable live-game watch page (#781) ─────
//
// Stable per-game URL (slug from game name) that shows the game's live
// video read-only — no login, no input. Resolves the slug against the
// same public wall data as /api/wall (fail-closed: only public games).
// When the resident isn't currently running, show a friendly offline
// state with a link back to the arcade.

interface WatchPageProps {
  params: Promise<{ slug: string }>;
}

async function resolveSlug(slug: string) {
  const games = await getWallGames();
  // Prefer a live instance of this slug; fall back to any match (offline).
  return (
    games.find((g) => g.slug === slug && g.live && g.roomUrl) ??
    games.find((g) => g.slug === slug) ??
    null
  );
}

export async function generateMetadata({ params }: WatchPageProps): Promise<Metadata> {
  const { slug } = await params;
  const game = await resolveSlug(slug);
  if (!game) {
    return { title: "Game not found — Sprite Cloud" };
  }
  const title = `${game.name} — live on Sprite Cloud`;
  const description = game.live
    ? `Watch ${game.name} (${game.platform}) live on the Sprite Cloud arcade. No account, no install.`
    : `${game.name} (${game.platform}) on the Sprite Cloud arcade — currently offline.`;
  const cover = game.coverUrl
    ? `${process.env.NEXT_PUBLIC_SITE_URL ?? "https://sprite-cloud.com"}${game.coverUrl}`
    : undefined;
  return {
    title,
    description,
    openGraph: {
      title,
      description,
      type: "video.other",
      ...(cover ? { images: [{ url: cover, width: 640, height: 480, alt: game.name }] } : {}),
      siteName: "Sprite Cloud",
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      ...(cover ? { images: [cover] } : {}),
    },
  };
}

export default async function WatchPage({ params }: WatchPageProps) {
  const { slug } = await params;
  const game = await resolveSlug(slug);

  // ── Offline / not found ───────────────────────────────────────────
  if (!game) {
    return (
      <main style={s.page}>
        <div style={s.center}>
          <h1 style={s.bigTitle}>Game not found</h1>
          <p style={s.sub}>
            This game isn&apos;t on the public arcade right now.
          </p>
          <Link href="/" style={s.link}>← Back to the arcade</Link>
        </div>
      </main>
    );
  }

  if (!game.live || !game.roomUrl) {
    return (
      <main style={s.page}>
        <div style={s.center}>
          <h1 style={s.bigTitle}>{game.name}</h1>
          <p style={s.sub}>
            {game.platform} — currently offline. It&apos;ll be back when the arcade
            brings it up again.
          </p>
          <Link href="/" style={s.link}>← Back to the arcade</Link>
        </div>
      </main>
    );
  }

  // ── Live watch page ───────────────────────────────────────────────
  return (
    <WatchPlayer
      roomToken={new URL(game.roomUrl, "https://sprite-cloud.com").pathname.split("/").pop()!.split("?")[0]!}
      gameId={game.id}
      serverId={game.serverId}
      gameName={game.name}
      platform={game.platform}
      players={game.players}
      viewers={game.viewers}
      roomUrl={game.roomUrl}
    />
  );
}

const s: Record<string, React.CSSProperties> = {
  page: {
    minHeight: "100vh",
    background: "#0a0f1a",
    color: "#e2e8f0",
    fontFamily: "system-ui, sans-serif",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  },
  center: {
    textAlign: "center" as const,
    padding: 24,
  },
  bigTitle: {
    fontSize: 28,
    margin: "0 0 8px",
  },
  sub: {
    color: "#94a3b8",
    fontSize: 15,
    margin: "0 0 20px",
  },
  link: {
    color: "#38bdf8",
    textDecoration: "none",
    fontSize: 14,
  },
};
