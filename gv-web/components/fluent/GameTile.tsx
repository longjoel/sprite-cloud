"use client";

import { useRef, useEffect, useState } from "react";
import { Card, Text, Badge } from "@fluentui/react-components";
import { Star20Regular, Star20Filled, Edit20Regular } from "@fluentui/react-icons";

// ── GameTile — Metro-style tile for the game library grid ──────────
//
// Sizes:
//   "square" → 1×1 (default)
//   "wide"   → 2×1 (span 2 columns)
//   "large"  → 2×2 (span 2 columns + 2 rows)

interface GameTileProps {
  game: {
    id: string;
    name: string;
    platform: string;
    maxPlayers: number;
  };
  size?: "square" | "wide" | "large";
  isFavorite?: boolean;
  onPlay: (gameId: string) => void;
  onToggleFavorite?: (gameId: string, e: React.MouseEvent) => void;
  onEdit?: (game: { id: string; name: string; platform: string; maxPlayers: number }) => void;
}

const sizeClassMap: Record<string, string> = {
  square: "tile-square",
  wide: "tile-wide",
  large: "tile-large",
};

export default function GameTile({
  game,
  size = "square",
  isFavorite = false,
  onPlay,
  onToggleFavorite,
  onEdit,
}: GameTileProps) {
  const sizeClass = sizeClassMap[size];
  const nameRef = useRef<HTMLSpanElement>(null);
  const [overflows, setOverflows] = useState(false);

  useEffect(() => {
    const el = nameRef.current;
    if (el) setOverflows(el.scrollWidth > el.clientWidth);
  }, [game.name]);

  return (
    <Card
      className={`game-tile ${sizeClass}`}
      onClick={() => onPlay(game.id)}
      appearance="filled-alternative"
      style={{ cursor: "pointer", userSelect: "none" }}
    >
      {/* Platform badge — top-left */}
      <Badge
        appearance="tint"
        color="informative"
        style={{
          position: "absolute",
          top: 8,
          left: 8,
          fontSize: 10,
          textTransform: "uppercase",
          letterSpacing: "0.05em",
        }}
      >
        {game.platform}
      </Badge>

      {/* Favorite star — top-right */}
      {onToggleFavorite && (
        <button
          onClick={(e) => onToggleFavorite(game.id, e)}
          style={{
            position: "absolute",
            top: 8,
            right: 8,
            background: "none",
            border: "none",
            cursor: "pointer",
            color: isFavorite ? "#38bdf8" : "#4b5563",
            padding: 2,
            lineHeight: 0,
          }}
          title={isFavorite ? "Remove favorite" : "Add favorite"}
        >
          {isFavorite ? <Star20Filled /> : <Star20Regular />}
        </button>
      )}

      {/* Game name — centered bottom */}
      <div
        style={{
          position: "absolute",
          bottom: 0,
          left: 0,
          right: 0,
          padding: "12px 36px 12px 16px",
          background: "linear-gradient(transparent, rgba(0,0,0,0.85))",
        }}
      >
        <span
          ref={nameRef}
          className={`game-tile-name${overflows ? "" : " no-overflow"}`}
          style={{
            fontWeight: 600,
            fontSize: size === "square" ? 13 : 14,
            lineHeight: 1.2,
            color: "var(--color-cloud)",
          }}
        >
          {game.name}
        </span>
        {game.maxPlayers > 1 && (
          <Text size={100} style={{ color: "#9ca3b8" }}>
            {game.maxPlayers}p
          </Text>
        )}
      </div>

      {/* Edit button — bottom-right, appears on hover */}
      {onEdit && (
        <button
          className="game-tile-edit-btn"
          onClick={(e) => {
            e.stopPropagation();
            onEdit(game);
          }}
          title="Rename game"
        >
          <Edit20Regular />
        </button>
      )}
    </Card>
  );
}
