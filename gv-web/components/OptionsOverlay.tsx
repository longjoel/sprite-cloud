"use client";

import { useCallback, type RefObject } from "react";
import styles from "./OptionsOverlay.module.css";

interface ActionItem {
  id: string;
  icon: string;
  label: string;
  action: () => void;
  danger?: boolean;
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
  onOpenRoom?: () => void;
  onQrCode: () => void;
  onStats: () => void;
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
  onOpenRoom,
  onQrCode,
  onStats,
  triggerRef,
  triggerDisabled = false,
}: OptionsOverlayProps) {
  const handleBackdropClick = useCallback((event: React.MouseEvent) => {
    if (event.target === event.currentTarget) onToggle();
  }, [onToggle]);

  if (!visible) {
    return null;
  }

  const groups: ActionGroup[] = [
    {
      id: "quick",
      label: "Quick",
      actions: [
        { id: "save", icon: "💾", label: "Save", action: onSave },
        { id: "load", icon: "📂", label: "Load", action: onLoad },
        {
          id: "fullscreen",
          icon: isFullscreen ? "↙" : "⛶",
          label: isFullscreen ? "Windowed" : "Fullscreen",
          action: onFullscreen,
        },
      ],
    },
    {
      id: "input",
      label: "Input",
      actions: [
        {
          id: "controls",
          icon: "🎮",
          label: controlsVisible ? "Hide controls" : "Show controls",
          action: onToggleControls,
        },
        { id: "controller", icon: "⌖", label: "Controller Layout", action: onOpenController },
        { id: "keys", icon: "⌨", label: "Keys", action: onOpenKeys },
      ],
    },
    {
      id: "session",
      label: "Session",
      actions: [
        { id: "saves", icon: "▤", label: "Saves", action: onOpenSaves },
        { id: "share", icon: "⌁", label: "Share / QR", action: onQrCode },
        ...(onOpenRoom
          ? [{ id: "room", icon: "👥", label: "Room controls", action: onOpenRoom }]
          : []),
      ],
    },
    {
      id: "diagnostics",
      label: "Diagnostics",
      actions: [
        { id: "stats", icon: "▥", label: "Stats for Nerds", action: onStats },
      ],
    },
    {
      id: "danger",
      label: "Danger",
      actions: [
        { id: "restart", icon: "↺", label: "Restart", action: onRestart, danger: true },
      ],
    },
  ];

  return (
    <div className={styles.backdrop} onClick={handleBackdropClick}>
      <div
        className={styles.panel}
        data-player-panel
        role="dialog"
        aria-modal="true"
        aria-label="Player options"
        tabIndex={-1}
      >
        {onClose && (
          <button className={`${styles.card} ${styles.libraryButton}`} onClick={onClose}>
            <span className={styles.cardIcon} aria-hidden="true">←</span>
            <span className={styles.cardLabel}>← Library</span>
          </button>
        )}
        {groups.map((group) => (
          <section className={`${styles.group} ${group.id === "danger" ? styles.dangerGroup : ""}`} key={group.id}>
            <h2 className={styles.groupTitle}>{group.label}</h2>
            <div className={styles.grid}>
              {group.actions.map((item) => (
                <button
                  key={item.id}
                  className={`${styles.card} ${item.danger ? styles.cardDanger : ""}`}
                  onClick={item.action}
                >
                  <span className={styles.cardIcon} aria-hidden="true">{item.icon}</span>
                  <span className={styles.cardLabel}>{item.label}</span>
                </button>
              ))}
            </div>
          </section>
        ))}
        <button className={styles.closeButton} onClick={onToggle}>
          <span aria-hidden="true">✕</span> Close
        </button>
      </div>
    </div>
  );
}
