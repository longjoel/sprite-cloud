"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import WallPreview from "./WallPreview";
import { pickFeatured, type WallGame } from "@/lib/wall-shared";

// ── FeaturedLive — home-page hero embed (#781) ────────────────────────
//
// Shows one live game big at the top and ROTATES through live games
// every FEATURE_ROTATE_MS (~60s). The currently featured game is
// excluded from the wall tiles below (LandingPage passes its key down
// to WallClient as excludeKey), so the live video never appears twice
// on the page. Reuses the WallPreview spectator path — read-only, no
// input, no player-seat consumption.

export const FEATURE_ROTATE_MS = 60_000;

interface FeaturedLiveProps {
  onFeatured?: (key: string | null) => void;
}

export default function FeaturedLive({ onFeatured }: FeaturedLiveProps) {
  const [games, setGames] = useState<WallGame[] | null>(null);
  const [featuredKey, setFeaturedKey] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  // Load the wall once; the hero is a snapshot — the tiles below
  // poll on their own cadence.
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
        // wall unavailable — hide the embed silently
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Rotate the featured game on an interval.
  useEffect(() => {
    if (!games) return;
    const timer = setInterval(() => {
      setFeaturedKey((prev) => pickFeatured(games, prev)?.key ?? null);
    }, FEATURE_ROTATE_MS);
    return () => clearInterval(timer);
  }, [games]);

  // Report the current featured key up to the parent (for the wall
  // exclusion) whenever it changes.
  useEffect(() => {
    onFeatured?.(featuredKey);
  }, [featuredKey, onFeatured]);

  const game = games?.find((g) => g.key === featuredKey) ?? null;

  if (!loaded || !game || !game.roomUrl) return null;

  const roomToken = game.roomUrl.split("/").pop()!.split("?")[0]!;

  return (
    <section style={s.section}>
      <div style={s.head}>
        <div>
          <h2 style={s.title}>
            <span style={s.liveDot} /> Live now
          </h2>
          <p style={s.sub}>
            {game.name} · {game.platform} — playing right now on this gateway.
          </p>
        </div>
        <div style={s.actions}>
          <Link href={game.watchUrl} style={s.watchLink}>Watch</Link>
          <Link href={game.roomUrl} style={s.playLink}>Play</Link>
        </div>
      </div>
      <Link href={game.watchUrl} style={s.videoLink} aria-label={`Watch ${game.name} live`}>
        <div style={s.videoWrap}>
          <WallPreview
            roomToken={roomToken}
            gameId={game.id}
            serverId={game.serverId}
            active
          />
        </div>
      </Link>
    </section>
  );
}

const s: Record<string, React.CSSProperties> = {
  section: {
    maxWidth: 900,
    margin: "0 auto",
    padding: "0 24px 8px",
  },
  head: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 16,
    flexWrap: "wrap",
    marginBottom: 12,
  },
  title: {
    fontSize: 18,
    margin: 0,
    display: "flex",
    alignItems: "center",
    gap: 8,
    color: "#e2e8f0",
  },
  liveDot: {
    width: 10,
    height: 10,
    borderRadius: "50%",
    background: "#f87171",
    display: "inline-block",
    boxShadow: "0 0 8px #f87171",
  },
  sub: {
    margin: "4px 0 0",
    fontSize: 13,
    color: "#94a3b8",
  },
  actions: {
    display: "flex",
    gap: 10,
  },
  watchLink: {
    color: "#e2e8f0",
    textDecoration: "none",
    border: "1px solid #334155",
    borderRadius: 8,
    padding: "6px 14px",
    fontSize: 13,
  },
  playLink: {
    background: "#38bdf8",
    color: "#0a0f1a",
    textDecoration: "none",
    fontWeight: 700,
    borderRadius: 8,
    padding: "6px 14px",
    fontSize: 13,
  },
  videoLink: {
    display: "block",
    textDecoration: "none",
  },
  videoWrap: {
    aspectRatio: "16 / 9",
    background: "#000",
    borderRadius: 12,
    overflow: "hidden",
    border: "1px solid #1e293b",
  },
};
