"use client";

import { useRef, useEffect, useState } from "react";
import { Card as MuiCard, CardActionArea, Chip, IconButton, CircularProgress, Button } from "@mui/material";
import { Star, StarBorder, Edit, MoreHoriz, DesktopWindows, Delete } from "@mui/icons-material";
import { getPlatformColor } from "@/lib/platformColors";

interface TileGame {
  id: string;
  serverId?: string | null;
  name: string;
  platform: string;
  maxPlayers: number;
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
  launching?: boolean;
}

const sizeClassMap = { square: "tile-square", wide: "tile-wide", large: "tile-large" } as const;

export default function GameTile({ game, size = "square", isFavorite = false, onPlay, onToggleFavorite, onEdit, onChooseHost, onDelete, launching = false }: GameTileProps) {
  const nameRef = useRef<HTMLSpanElement>(null);
  const [overflows, setOverflows] = useState(false);

  useEffect(() => {
    const element = nameRef.current;
    if (element) setOverflows(element.scrollWidth > element.clientWidth);
  }, [game.name]);

  const stop = (action: (event: React.MouseEvent) => void) => (event: React.MouseEvent) => {
    event.stopPropagation();
    action(event);
  };

  const favLabel = isFavorite ? `Remove ${game.name} from favorites` : `Add ${game.name} to favorites`;


  const actionButtons = (mobile = false) => (
    <div className={mobile ? "game-tile-overflow-actions" : "game-tile-secondary-actions"}>
      {onToggleFavorite && (
        mobile ? (
          <Button size="small" aria-label={favLabel} onClick={stop((event) => onToggleFavorite(game, event))} startIcon={isFavorite ? <Star fontSize="inherit" /> : <StarBorder fontSize="inherit" />}>
            {isFavorite ? "Remove Favorite" : "Add Favorite"}
          </Button>
        ) : (
          <IconButton size="small" aria-label={favLabel} onClick={stop((event) => onToggleFavorite(game, event))}>
            {isFavorite ? <Star fontSize="inherit" /> : <StarBorder fontSize="inherit" />}
          </IconButton>
        )
      )}

      {onEdit && (
        mobile ? (
          <Button size="small" aria-label={`Rename ${game.name}`} onClick={stop(() => onEdit(game))} startIcon={<Edit fontSize="inherit" />}>
            Rename
          </Button>
        ) : (
          <IconButton size="small" aria-label={`Rename ${game.name}`} onClick={stop(() => onEdit(game))}>
            <Edit fontSize="inherit" />
          </IconButton>
        )
      )}
      {onChooseHost && (
        <Button
          size="small"
          disabled={launching}
          aria-label={`Choose host for ${game.name}`}
          onClick={stop(() => onChooseHost(game))}
          startIcon={<DesktopWindows fontSize="inherit" />}
          sx={{ fontSize: 11, minWidth: 0 }}
        >
          Choose Host
        </Button>
      )}
      {onDelete && (
        mobile ? (
          <Button size="small" aria-label={`Delete ${game.name}`} onClick={stop(() => onDelete(game))} startIcon={<Delete fontSize="inherit" />} color="error">
            Delete
          </Button>
        ) : (
          <IconButton size="small" aria-label={`Delete ${game.name}`} onClick={stop(() => onDelete(game))} color="error">
            <Delete fontSize="inherit" />
          </IconButton>
        )
      )}
    </div>
  );

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
        sx={{ height: "100%", width: "100%" }}
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
      {actionButtons()}
      <details className="game-tile-overflow" onClick={(event) => event.stopPropagation()}>
        <summary aria-label={`More actions for ${game.name}`}>
          <MoreHoriz fontSize="inherit" />
        </summary>
        {actionButtons(true)}
      </details>
      <div className="game-tile-caption">
        <span ref={nameRef} className={`game-tile-name${overflows ? "" : " no-overflow"}`}>{game.name}</span>
        <span className="game-tile-platform-text">{game.platform}</span>
      </div>
    </MuiCard>
  );
}
