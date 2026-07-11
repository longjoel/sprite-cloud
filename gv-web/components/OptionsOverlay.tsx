"use client";

import { useCallback, useRef, useState } from "react";
import styles from "./OptionsOverlay.module.css";

// ── Types ─────────────────────────────────────────────────────────────

interface ActionCard {
  id: string;
  icon: string;
  label: string;
  danger?: boolean;
  action: () => void;
}

interface OptionsOverlayProps {
  visible: boolean;
  onToggle: () => void;
  onSave: () => void;
  onLoad: () => void;
  onSnapshot: () => void;
  onFullscreen: () => void;
  isFullscreen: boolean;
  onReposition: () => void;
  onResetPosition: () => void;
  onRestart: () => void;
  onOpenSaves: () => void;
  onOpenKeys: () => void;
  onOpenRoom: () => void;
  onCast?: () => void;
  onQrCode?: () => void;
  onStats?: () => void;
  isMobile?: boolean;
}

// ── Component ─────────────────────────────────────────────────────────

export default function OptionsOverlay({
  visible,
  onToggle,
  onSave,
  onLoad,
  onSnapshot,
  onFullscreen,
  isFullscreen,
  onReposition,
  onResetPosition,
  onRestart,
  onOpenSaves,
  onOpenKeys,
  onOpenRoom,
  onCast,
  onQrCode,
  onStats,
  isMobile = false,
}: OptionsOverlayProps) {
  const [flash, setFlash] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);

  const handleSnapshot = useCallback(() => {
    setFlash(true);
    setTimeout(() => setFlash(false), 350);
    onSnapshot();
  }, [onSnapshot]);

  // Prevent video clicks from passing through when overlay is open
  const handleBackdropClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === e.currentTarget) {
        onToggle();
      }
    },
    [onToggle],
  );

  if (!visible) {
    return (
      <button
        className={styles.toggleBtn}
        onClick={onToggle}
        aria-label="Open options"
        title="Options"
      >
        ⋯
      </button>
    );
  }

  const mainCards: ActionCard[] = [
    { id: "save", icon: "💾", label: "Quick Save", action: onSave },
    { id: "load", icon: "📂", label: "Quick Load", action: onLoad },
    { id: "snapshot", icon: "📸", label: "Snapshot", action: handleSnapshot },
    {
      id: "fullscreen",
      icon: isFullscreen ? "↙" : "⛶",
      label: isFullscreen ? "Windowed" : "Fullscreen",
      action: onFullscreen,
    },
    { id: "restart", icon: "↺", label: "Restart", action: onRestart, danger: true },
  ];

  const subCards: ActionCard[] = [
    { id: "saves", icon: "📋", label: "Saves", action: onOpenSaves },
    { id: "keys", icon: "🎮", label: "Keys", action: onOpenKeys },
    { id: "gamepad", icon: "📱", label: "Gamepad", action: onReposition },
    { id: "resetpos", icon: "⟲", label: "Reset Pos", action: onResetPosition },
    ...(isMobile && onCast ? [{ id: "cast", icon: "📺", label: "Cast", action: onCast }] : []),
    ...(onQrCode ? [{ id: "qrcode", icon: "📱", label: "QR Code", action: onQrCode }] : []),
    ...(onStats ? [{ id: "stats", icon: "📊", label: "Stats", action: onStats }] : []),
  ];

  return (
    <>
      {flash && <div className={styles.flash} />}
      <div className={styles.backdrop} onClick={handleBackdropClick}>
        <div className={styles.panel} ref={panelRef}>
          {/* Row 1: Main actions */}
          <div className={styles.grid}>
            {mainCards.map((card) => (
              <button
                key={card.id}
                className={`${styles.card} ${card.danger ? styles.cardDanger : ""}`}
                onClick={card.action}
              >
                <span className={styles.cardIcon}>{card.icon}</span>
                <span className={styles.cardLabel}>{card.label}</span>
              </button>
            ))}
          </div>

          {/* Row 2: Sub actions */}
          <div className={styles.grid}>
            {subCards.map((card) => (
              <button
                key={card.id}
                className={styles.card}
                onClick={card.action}
              >
                <span className={styles.cardIcon}>{card.icon}</span>
                <span className={styles.cardLabel}>{card.label}</span>
              </button>
            ))}
            {/* Dismiss button */}
            <button
              className={styles.card}
              onClick={onToggle}
            >
              <span className={styles.cardIcon}>✕</span>
              <span className={styles.cardLabel}>Close</span>
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
