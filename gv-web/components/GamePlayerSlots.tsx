"use client";

import React from "react";
import { Button } from "@/components/ui";
import styles from "./GamePlayer.module.css";

interface GamePlayerSlotsProps {
  show: boolean;
  onClose: () => void;
  onSave: (slot: number) => void;
  onLoad: (slot: number) => void;
}

export default function GamePlayerSlots({
  show,
  onClose,
  onSave,
  onLoad,
}: GamePlayerSlotsProps) {
  if (!show) return null;

  const slotNumbers = [1, 2, 3, 4, 5, 6, 7, 8, 9];

  return (
    <>
      <div className={styles.backdrop} onClick={onClose} />
      <div className={styles.slotPanel}>
        <div className={styles.slotHeader}>
          <span>Save</span>
          <Button variant="ghost" onClick={onClose}>✕</Button>
        </div>
        <div className={styles.slotRow}>
          {slotNumbers.map((n) => (
            <button key={`save-${n}`} className={styles.slotBtn} onClick={() => onSave(n)}>
              {n}
            </button>
          ))}
        </div>
        <div className={styles.slotHeader} style={{ marginTop: 12 }}>Load</div>
        <div className={styles.slotRow}>
          {slotNumbers.map((n) => (
            <button key={`load-${n}`} className={styles.slotBtn} onClick={() => onLoad(n)}>
              {n}
            </button>
          ))}
        </div>
      </div>
    </>
  );
}
