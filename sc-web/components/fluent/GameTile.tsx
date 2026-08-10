"use client";

import { Card as MuiCard, CardActionArea, Chip, CircularProgress, Box, Typography } from "@mui/material";
import { getPlatformColor } from "@/lib/platformColors";
import GameTileContextMenu from "./GameTileContextMenu";

interface TileGame {
  id: string;
  serverId?: string | null;
  name: string;
  platform: string;
  maxPlayers: number;
  coverUrl?: string | null;
  verification?: { state: "verified" | "unverified" } | null;
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
  isPublic?: boolean;
  onTogglePublic?: (game: TileGame) => void;
  isAlwaysOn?: boolean;
  onToggleAlwaysOn?: (game: TileGame) => void;
  isFreePlay?: boolean;
  onToggleFreePlay?: (game: TileGame) => void;
  launching?: boolean;
}

const sizeStyles = {
  square: { gridColumn: "span 1", gridRow: "span 1" },
  wide: { gridColumn: "span 2", gridRow: "span 1" },
  large: { gridColumn: "span 2", gridRow: "span 2" },
} as const;

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
  isPublic,
  onTogglePublic,
  isAlwaysOn,
  onToggleAlwaysOn,
  isFreePlay,
  onToggleFreePlay,
  launching = false,
}: GameTileProps) {
  const hasContextActions = !!(
    onToggleFavorite || onEdit || onChooseHost || onDelete || onDownload ||
    onTogglePublic || onToggleAlwaysOn || onToggleFreePlay
  );

  return (
    <MuiCard
      className="game-tile"
      role="group"
      sx={{
        ...sizeStyles[size],
        position: "relative",
        minHeight: { xs: 180, sm: 200 },
        aspectRatio: { xs: "auto", sm: "3 / 4" },
        overflow: "hidden",
        userSelect: "none",
        background: getPlatformColor(game.platform),
        border: 1,
        borderColor: isFavorite ? "primary.main" : "transparent",
        boxShadow: isFavorite ? 3 : 1,
        transition: "transform 120ms ease, border-color 150ms ease, box-shadow 150ms ease",
        "&:hover": { transform: "scale(1.02)", borderColor: "primary.main", boxShadow: 4 },
        "&:active": { transform: "scale(0.98)" },
        "&:focus-within": { borderColor: "primary.main" },
        "@media (max-width:640px)": {
          ...(size !== "square" ? { gridColumn: "span 2", gridRow: "span 1" } : {}),
          minHeight: 180,
          aspectRatio: "auto",
        },
        "@media (prefers-reduced-motion: reduce)": {
          transition: "none",
          "&:hover, &:active": { transform: "none" },
        },
      }}
    >
      <CardActionArea
        disabled={launching}
        aria-label={`Play ${game.name}`}
        onClick={() => onPlay(game)}
        sx={{
          position: "absolute",
          inset: 0,
          ...(game.coverUrl
            ? {
                backgroundImage: `url(${game.coverUrl})`,
                backgroundSize: "cover",
                backgroundPosition: "center",
              }
            : {}),
        }}
      >
        {launching && <CircularProgress size={20} sx={{ position: "absolute", top: 8, right: 8 }} />}
      </CardActionArea>

      <Chip
        label={game.platform}
        size="small"
        color="primary"
        variant="outlined"
        className="game-tile-platform"
        sx={{ position: "absolute", top: 6, left: 6, zIndex: 1, pointerEvents: "none" }}
      />

      {game.verification?.state && (
        <Chip
          label={game.verification.state === "verified" ? "✓ Verified" : "Unverified"}
          size="small"
          color={game.verification.state === "verified" ? "success" : "warning"}
          variant="filled"
          className={`game-tile-verification game-tile-verification-${game.verification.state}`}
          sx={{ position: "absolute", top: 34, left: 6, zIndex: 1, pointerEvents: "none" }}
        />
      )}

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
          isPublic={isPublic}
          onTogglePublic={onTogglePublic ? () => onTogglePublic(game) : undefined}
          isAlwaysOn={isAlwaysOn}
          onToggleAlwaysOn={onToggleAlwaysOn ? () => onToggleAlwaysOn(game) : undefined}
          isFreePlay={isFreePlay}
          onToggleFreePlay={onToggleFreePlay ? () => onToggleFreePlay(game) : undefined}
          triggerAriaLabel={`More actions for ${game.name}`}
        />
      )}

      <Box
        sx={{
          position: "absolute",
          inset: "auto 0 0",
          zIndex: 2,
          px: 2,
          pt: 4,
          pb: 1.5,
          pr: 6,
          pointerEvents: "none",
          background: "linear-gradient(transparent, rgba(0, 0, 0, 0.88))",
        }}
      >
        <Typography
          component="span"
          variant="body2"
          sx={{ display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontWeight: 600 }}
        >
          {game.name}
        </Typography>
        <Typography
          component="span"
          variant="caption"
          color="text.secondary"
          sx={{ display: "block", mt: 0.5, textTransform: "uppercase", letterSpacing: "0.05em" }}
        >
          {game.platform}
        </Typography>
      </Box>
    </MuiCard>
  );
}
