"use client";

import { useCallback, type RefObject } from "react";
import { Box, Button, Typography } from "@mui/material";
import type { SvgIconComponent } from "@mui/icons-material";
import {
  ArrowBack,
  Close,
  Eject,
  FolderOpen,
  Fullscreen,
  FullscreenExit,
  Gamepad,
  Groups,
  Keyboard,
  QueryStats,
  QrCode,
  RestartAlt,
  Save,
  TableRows,
  VpnKey,
  Visibility,
  VolumeOff,
  VolumeUp,
} from "@mui/icons-material";
import styles from "./OptionsOverlay.module.css";
import type { PlayerCapabilities } from "@/lib/capabilities";
import { APP_NAVIGATION } from "@/lib/ui/app-navigation";

interface ActionItem {
  id: string;
  icon: SvgIconComponent;
  label: string;
  action: () => void;
  danger?: boolean;
  disabled?: boolean;
}

interface ActionGroup {
  id: string;
  label: string;
  actions: ActionItem[];
}

interface OptionsOverlayProps {
  visible: boolean;
  onToggle: () => void;
  onClose?: () => void;
  onSave: () => void;
  onLoad: () => void;
  onFullscreen: () => void;
  isFullscreen: boolean;
  controlsVisible: boolean;
  onToggleControls: () => void;
  onOpenController: () => void;
  onRestart: () => void;
  onOpenSaves: () => void;
  onOpenKeys: () => void;
  onEject?: () => void;
  onOpenRoom?: () => void;
  onQrCode?: () => void;
  onStats: () => void;
  capabilities?: PlayerCapabilities;
  seat?: number;
  /** Whether multiplayer room controls are relevant for this session */
  roomRelevant?: boolean;
  /** Audio mute state + toggle for Display & Audio group */
  audioMuted?: boolean;
  onToggleAudio?: () => void;
  triggerRef?: RefObject<HTMLButtonElement | null>;
  triggerDisabled?: boolean;
}

export default function OptionsOverlay({
  visible,
  onToggle,
  onClose,
  onSave,
  onLoad,
  onFullscreen,
  isFullscreen,
  controlsVisible,
  onToggleControls,
  onOpenController,
  onRestart,
  onOpenSaves,
  onOpenKeys,
  onEject,
  onOpenRoom,
  onQrCode,
  onStats,
  capabilities,
  seat,
  roomRelevant = false,
  audioMuted,
  onToggleAudio,
  triggerRef,
  triggerDisabled = false,
}: OptionsOverlayProps) {
  const handleBackdropClick = useCallback((event: React.MouseEvent) => {
    if (event.target === event.currentTarget) onToggle();
  }, [onToggle]);

  if (!visible) {
    return null;
  }

  const isHost = capabilities?.role === "host";
  const isPlayer = capabilities?.role === "player";
  const isSpectator = capabilities?.role === "spectator" || (!isHost && !!capabilities);
  const playerLabel = seat != null ? `Player ${seat + 1}` : "";

  const groups: ActionGroup[] = [
    {
      id: "game",
      label: "Game",
      actions: [
        { id: "save", icon: Save, label: "Save", action: onSave, disabled: !isHost },
        { id: "load", icon: FolderOpen, label: "Load", action: onLoad, disabled: !isHost },
        { id: "saves", icon: TableRows, label: "Saves", action: onOpenSaves, disabled: !isHost },
        {
          id: "restart",
          icon: RestartAlt,
          label: "Restart",
          action: onRestart,
          danger: true,
          disabled: !isHost,
        },
        ...(onEject && isHost
          ? [{
              id: "eject" as const,
              icon: Eject,
              label: "Eject disk",
              action: onEject,
              danger: true,
            }]
          : []),
      ],
    },
    {
      id: "controls",
      label: "Controls",
      actions: [
        {
          id: "controls",
          icon: Gamepad,
          label: controlsVisible ? "Hide controls" : "Show controls",
          action: onToggleControls,
          disabled: isSpectator,
        },
        { id: "controller", icon: Gamepad, label: "Controller Layout", action: onOpenController, disabled: isSpectator },
        { id: "keys", icon: Keyboard, label: "Keys", action: onOpenKeys, disabled: isSpectator },
      ],
    },
    ...(roomRelevant
      ? [
          {
            id: "multiplayer" as const,
            label: "Multiplayer",
            actions: [
              ...(onOpenRoom
                ? [{ id: "room", icon: Groups, label: "Room", action: onOpenRoom }]
                : []),
              ...(onQrCode && isHost
                ? [{ id: "share", icon: QrCode, label: "Share / QR", action: onQrCode }]
                : []),
            ],
          },
        ]
      : []),
    {
      id: "display",
      label: "Display & Audio",
      actions: [
        ...(onToggleAudio
          ? [{
              id: "mute",
              icon: audioMuted ? VolumeOff : VolumeUp,
              label: audioMuted ? "Unmute" : "Mute",
              action: onToggleAudio,
            }]
          : []),
        {
          id: "fullscreen",
          icon: isFullscreen ? FullscreenExit : Fullscreen,
          label: isFullscreen ? "Windowed" : "Fullscreen",
          action: onFullscreen,
        },
      ],
    },
    {
      id: "troubleshooting",
      label: "Troubleshooting",
      actions: [
        { id: "stats", icon: QueryStats, label: "Stats for Nerds", action: onStats },
      ],
    },
  ];

  return (
    <Box className={styles.backdrop} onClick={handleBackdropClick}>
      <div
        className={styles.panel}
        data-player-panel
        role="dialog"
        aria-modal="true"
        aria-label="Player options"
        tabIndex={-1}
      >
        {onClose && (
          <Button variant="text" className={`${styles.card} ${styles.libraryButton}`} onClick={onClose}>
            <Typography component="span" className={styles.cardIcon} aria-hidden="true"><ArrowBack /></Typography>
            <Typography component="span" className={styles.cardLabel} aria-label="← Library">
              {`← ${APP_NAVIGATION.library.label}`}
            </Typography>
          </Button>
        )}
        {capabilities && (
          <Box className={styles.roleBanner}>
            <Typography component="span" className={styles.roleLabel}>
              {isHost ? <><VpnKey aria-hidden="true" /> Host</> : isPlayer ? <><Gamepad aria-hidden="true" /> {playerLabel}</> : <><Visibility aria-hidden="true" /> Spectator</>}
            </Typography>
          </Box>
        )}
        {groups.map((group) => (
          <section className={`${styles.group} ${group.id === "game" ? styles.dangerGroup : ""}`} key={group.id}>
            <h2 className={styles.groupTitle}>{group.label}</h2>
            <div className={styles.grid}>
              {group.actions.map((item) => (
                <Button
                  key={item.id}
                  variant="text"
                  className={`${styles.card} ${item.danger ? styles.cardDanger : ""} ${item.disabled ? styles.cardDisabled : ""}`}
                  onClick={item.disabled ? undefined : item.action}
                  disabled={item.disabled}
                >
                  <Typography component="span" className={styles.cardIcon} aria-hidden="true"><item.icon /></Typography>
                  <Typography component="span" className={styles.cardLabel}>{item.label}</Typography>
                </Button>
              ))}
            </div>
          </section>
        ))}
        <Button variant="text" className={styles.closeButton} onClick={onToggle}>
          <Typography component="span" aria-hidden="true"><Close /></Typography> Close
        </Button>
      </div>
    </Box>
  );
}
