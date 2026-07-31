"use client";

import { useRef, useEffect, useState } from "react";
import { Card as MuiCard, CardActionArea, Chip, CircularProgress } from "@mui/material";
import { getPlatformColor } from "@/lib/platformColors";
import GameTileContextMenu from "./GameTileContextMenu";

interface TileGame {
  id: string;
  serverId?: string | null;
  name: string;
  platform: string;
  maxPlayers: number;
  coverUrl?: string | null;
}

interface GameTileProps {
  game: TileGame;
  size?: "square" | "wide" | "large";
  isFavorite?: boolean;

  onPlay: (game: TileGame) => void;
  onToggleFavorite?: (game: TileGame, e: React.MouseEvent) => void;

  onEdit?: (game: TileGame) => void;
  onChooseHost?: (game: TileGame) => void;
  onDelete?: (game: TileGame) => void;
  onDownload?: (game: TileGame) => void;
  launching?: boolean;
}

const sizeClassMap = { square: "tile-square", wide: "tile-wide", large: "tile-large" } as const;

export default function GameTile({
  game,
  size = "square",
  isFavorite = false,
  onPlay,
  onToggleFavorite,
  onEdit,
  onChooseHost,
  onDelete,
  onDownload,
  launching = false,
}: GameTileProps) {
  const nameRef = useRef<HTMLSpanElement>(null);
  const [overflows, setOverflows] = useState(false);

  useEffect(() => {
    const element = nameRef.current;
    if (element) setOverflows(element.scrollWidth > element.clientWidth);
  }, [game.name]);

  // Detect whether the context menu has any actions to show
  const hasContextActions = !!(onToggleFavorite || onEdit || onChooseHost || onDelete || onDownload);

  return (
    <MuiCard
      className={`game-tile ${sizeClassMap[size]} ${isFavorite ? "is-favorite" : ""}`.trim()}
      role="group"
      sx={{ userSelect: "none", background: getPlatformColor(game.platform), position: "relative" }}
    >
      <CardActionArea
        disabled={launching}
        aria-label={`Play ${game.name}`}
        onClick={() => onPlay(game)}
        sx={{
          height: "100%",
          width: "100%",
          ...(game.coverUrl
            ? {
                backgroundImage: `url(${game.coverUrl})`,
                backgroundSize: "cover",
                backgroundPosition: "center",
              }
            : {}),
        }}
      >
        {launching && <CircularProgress size={16} sx={{ position: "absolute", top: 8, right: 8 }} />}
      </CardActionArea>

      <Chip
        label={game.platform}
        size="small"
        color="primary"
        variant="outlined"
        className="game-tile-platform"
        sx={{ position: "absolute", top: 6, left: 6, zIndex: 1 }}
      />

      {/* Context menu (replaces individual action buttons and ⋮ overflow) */}
      {hasContextActions && (
        <GameTileContextMenu
          game={game}
          isFavorite={isFavorite}
          onToggleFavorite={
            onToggleFavorite ? () => onToggleFavorite(game, {} as React.MouseEvent) : undefined
          }
          onRename={onEdit ? () => onEdit(game) : undefined}
          onChooseHost={onChooseHost ? () => onChooseHost(game) : undefined}
          onDelete={onDelete ? () => onDelete(game) : undefined}
          onDownload={onDownload ? () => onDownload(game) : undefined}
          triggerAriaLabel={`More actions for ${game.name}`}
        />
      )}

      <div className="game-tile-caption">
        <span ref={nameRef} className={`game-tile-name${overflows ? "" : " no-overflow"}`}>{game.name}</span>
        <span className="game-tile-platform-text">{game.platform}</span>
      </div>
    </MuiCard>
  );
}
