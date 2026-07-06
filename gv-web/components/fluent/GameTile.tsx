"use client";

import { useRef, useEffect, useState } from "react";
import { Card, Text, Badge } from "@fluentui/react-components";
import { Star20Regular, Star20Filled, Edit20Regular, Pin20Regular, Pin20Filled } from "@fluentui/react-icons";
import { getPlatformColor } from "@/lib/platformColors";

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
  isPinned?: boolean;
  onPlay: (gameId: string) => void;
  onToggleFavorite?: (gameId: string, e: React.MouseEvent) => void;
  onTogglePin?: (gameId: string, e: React.MouseEvent) => void;
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
  isPinned = false,
  onPlay,
  onToggleFavorite,
  onTogglePin,
  onEdit,
}: GameTileProps) {
  const sizeClass = sizeClassMap[size];
  const stateClasses = [
    isFavorite ? "is-favorite" : "",
    isPinned ? "is-pinned" : "",
  ]
    .filter(Boolean)
    .join(" ");
  const nameRef = useRef<HTMLSpanElement>(null);
  const [overflows, setOverflows] = useState(false);
  const platformBg = getPlatformColor(game.platform);

  useEffect(() => {
    const el = nameRef.current;
    if (el) setOverflows(el.scrollWidth > el.clientWidth);
  }, [game.name]);

  return (
    <Card
    className={`game-tile ${sizeClass} ${stateClasses}`.trim()}
    onClick={() => onPlay(game.id)}
    appearance="filled-alternative"
    style={{ cursor: "pointer", userSelect: "none", background: platformBg }}
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

      {/* Quick actions — top-right */}
      {(onToggleFavorite || onTogglePin) && (
        <div
          style={{
            position: "absolute",
            top: 8,
            right: 8,
            display: "flex",
            alignItems: "center",
            gap: 4,
          }}
        >
          {onTogglePin && (
            <button
              onClick={(e) => onTogglePin(game.id, e)}
              style={{
                background: "none",
                border: "none",
                cursor: "pointer",
                color: isPinned ? "#38bdf8" : "#4b5563",
                padding: 2,
                lineHeight: 0,
              }}
              title={isPinned ? "Unpin" : "Pin"}
            >
              {isPinned ? <Pin20Filled /> : <Pin20Regular />}
            </button>
          )}
          {onToggleFavorite && (
            <button
              onClick={(e) => onToggleFavorite(game.id, e)}
              style={{
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
        </div>
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
        <div className="game-tile-meta-row">
          <span className="game-tile-meta-pill">{game.platform}</span>
          <span className="game-tile-meta-pill">
            {game.maxPlayers > 1 ? `${game.maxPlayers}p` : "1p"}
          </span>
          {isPinned && <span className="game-tile-meta-pill is-accent">Pinned</span>}
          {isFavorite && <span className="game-tile-meta-pill is-accent">Favorite</span>}
        </div>
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
