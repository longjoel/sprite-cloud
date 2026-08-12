"use client";

import { useState, useCallback } from "react";
import { Menu, MenuItem, ListItemIcon, ListItemText, Divider, IconButton } from "@mui/material";
import {
  Star,
  StarBorder,
  Edit,
  DesktopWindows,
  Delete,
  Download,
  MoreVert,
  Public,
  Power,
  ImageOutlined,
} from "@mui/icons-material";

// ── Types ──────────────────────────────────────────────────────────

export interface ContextMenuGame {
  id: string;
  name: string;
}

interface ActionDef {
  id: string;
  label: string;
  icon: React.ReactNode;
  color?: "error";
  divider?: boolean;
  onClick: () => void;
}

interface GameTileContextMenuProps {
  game: ContextMenuGame;
  /** Whether this game is in favorites. */
  isFavorite: boolean;
  /** Favorite toggle callback. */
  onToggleFavorite?: () => void;
  /** Rename callback. */
  onRename?: () => void;
  /** Choose host callback. */
  onChooseHost?: () => void;
  /** Delete callback (admin only). */
  onDelete?: () => void;
  /** Download callback (admin only). */
  onDownload?: () => void;
  /** Change server-wide cover callback (admin only). */
  onChangeCover?: () => void;
  /** Public-wall toggle (admin only, #762). */
  isPublic?: boolean;
  onTogglePublic?: () => void;
  /** Always-on toggle (admin only, #762). */
  isAlwaysOn?: boolean;
  onToggleAlwaysOn?: () => void;
  /** Free-play toggle (admin only, #762). */
  isFreePlay?: boolean;
  onToggleFreePlay?: () => void;
  /** Label for the trigger button. */
  triggerAriaLabel?: string;
}

// ── Long-press helper ──────────────────────────────────────────────

const LONG_PRESS_MS = 500;

function useLongPress(onLongPress: (e: React.TouchEvent) => void) {
  const [timer, setTimer] = useState<ReturnType<typeof setTimeout> | null>(null);

  const onTouchStart = useCallback(
    (e: React.TouchEvent) => {
      // Only single-touch
      if (e.touches.length !== 1) return;
      const t = setTimeout(() => {
        onLongPress(e);
      }, LONG_PRESS_MS);
      setTimer(t);
    },
    [onLongPress],
  );

  const onTouchEnd = useCallback(() => {
    if (timer) {
      clearTimeout(timer);
      setTimer(null);
    }
  }, [timer]);

  const onTouchMove = useCallback(() => {
    if (timer) {
      clearTimeout(timer);
      setTimer(null);
    }
  }, [timer]);

  return { onTouchStart, onTouchEnd, onTouchMove };
}

// ── Component ──────────────────────────────────────────────────────

export default function GameTileContextMenu({
  game,
  isFavorite,
  onToggleFavorite,
  onRename,
  onChooseHost,
  onDelete,
  onDownload,
  onChangeCover,
  isPublic,
  onTogglePublic,
  isAlwaysOn,
  onToggleAlwaysOn,
  isFreePlay,
  onToggleFreePlay,
  triggerAriaLabel,
}: GameTileContextMenuProps) {
  const [anchorEl, setAnchorEl] = useState<null | HTMLElement>(null);
  const [anchorPos, setAnchorPos] = useState<{ top: number; left: number } | null>(null);
  const open = Boolean(anchorEl);

  // ── Open at pointer position ─────────────────────────────────────
  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setAnchorEl(e.currentTarget as HTMLElement);
    setAnchorPos({ top: e.clientY, left: e.clientX });
  }, []);

  // ── Long press ───────────────────────────────────────────────────
  const longPress = useLongPress(
    useCallback(
      (e: React.TouchEvent) => {
        const touch = e.touches[0] || e.changedTouches[0];
        setAnchorEl(e.currentTarget as HTMLElement);
        setAnchorPos({ top: touch.clientY, left: touch.clientX });
      },
      [],
    ),
  );

  // ── ⋮ trigger button ────────────────────────────────────────────
  const handleTriggerClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setAnchorEl(e.currentTarget as HTMLElement);
    setAnchorPos({ top: rect.bottom + 4, left: rect.left });
  }, []);

  // ── Close ────────────────────────────────────────────────────────
  const handleClose = useCallback(() => {
    setAnchorEl(null);
    setAnchorPos(null);
  }, []);

  // ── Build action list ────────────────────────────────────────────
  const actions: ActionDef[] = [];
  if (onRename) {
    actions.push({
      id: "rename",
      label: "Rename",
      icon: <Edit fontSize="small" />,
      onClick: () => {
        handleClose();
        onRename();
      },
    });
  }
  if (onChooseHost) {
    actions.push({
      id: "choose-host",
      label: "Choose Host",
      icon: <DesktopWindows fontSize="small" />,
      onClick: () => {
        handleClose();
        onChooseHost();
      },
    });
  }
  if (onChangeCover) {
    actions.push({
      id: "change-cover",
      label: "Change cover",
      icon: <ImageOutlined fontSize="small" />,
      onClick: () => {
        handleClose();
        onChangeCover();
      },
    });
  }
  if (onTogglePublic) {
    actions.push({
      id: "public-wall",
      label: isPublic ? "Remove from public wall" : "Put on the public wall",
      icon: <Public fontSize="small" />,
      onClick: () => {
        handleClose();
        onTogglePublic();
      },
    });
  }
  if (onToggleAlwaysOn) {
    actions.push({
      id: "always-on",
      label: isAlwaysOn ? "Always on — turn off" : "Always on",
      icon: <Power fontSize="small" />,
      onClick: () => {
        handleClose();
        onToggleAlwaysOn();
      },
    });
  }
  if (onToggleFreePlay) {
    actions.push({
      id: "free-play",
      label: isFreePlay ? "Free play — turn off" : "Free play",
      icon: <Power fontSize="small" />,
      onClick: () => {
        handleClose();
        onToggleFreePlay();
      },
    });
  }
  if (onDownload) {
    actions.push({
      id: "download",
      label: "Download",
      icon: <Download fontSize="small" />,
      onClick: () => {
        handleClose();
        onDownload();
      },
    });
  }
  if (onDelete) {
    if (actions.length > 0) {
      // Add visual separator before destructive action
      actions[actions.length - 1].divider = true;
    }
    actions.push({
      id: "delete",
      label: "Delete",
      icon: <Delete fontSize="small" />,
      color: "error",
      onClick: () => {
        handleClose();
        onDelete();
      },
    });
  }
  if (onToggleFavorite) {
    actions.push({
      id: "favorite",
      label: isFavorite ? "Remove Favorite" : "Add Favorite",
      icon: isFavorite ? <Star fontSize="small" /> : <StarBorder fontSize="small" />,
      onClick: () => {
        handleClose();
        onToggleFavorite();
      },
    });
  }

  // ── No actions → no UI ──────────────────────────────────────────
  if (actions.length === 0) return null;

  return (
    <>
      {/* ── ⋮ trigger button ────────────────────────────────────── */}
      <IconButton
        size="small"
        aria-label={triggerAriaLabel ?? `More actions for ${game.name}`}
        onClick={handleTriggerClick}
        onContextMenu={handleContextMenu}
        sx={{ position: "absolute", top: 4, right: 4, zIndex: 2 }}
      >
        <MoreVert fontSize="inherit" />
      </IconButton>

      {/* ── Context menu ─────────────────────────────────────────── */}
      <Menu
        anchorEl={anchorEl}
        open={open}
        onClose={handleClose}
        anchorReference={anchorPos ? "anchorPosition" : "anchorEl"}
        anchorPosition={anchorPos ? { top: anchorPos.top, left: anchorPos.left } : undefined}
        slotProps={{
          paper: {
            sx: { minWidth: 170 },
          },
          list: {
            "aria-label": `Actions for ${game.name}`,
            dense: true,
          },
        }}
      >
        {actions.map((action, index) => [
          action.divider ? <Divider key={`div-${action.id}`} /> : null,
          <MenuItem
            key={action.id}
            onClick={action.onClick}
            sx={action.color === "error" ? { color: "error.main" } : undefined}
          >
            <ListItemIcon sx={action.color === "error" ? { color: "inherit" } : undefined}>
              {action.icon}
            </ListItemIcon>
            <ListItemText>{action.label}</ListItemText>
          </MenuItem>,
        ]).flat().filter(Boolean)}
      </Menu>
    </>
  );
}
