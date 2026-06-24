"use client";

import React from "react";
import { Button } from "@/components/ui";
import styles from "./GamePlayer.module.css";

interface GamePlayerRoomControlsProps {
  show: boolean;
  roomToken: string | null;
  gameId: string;
  onClose: () => void;
  sendDC: (cmd: Record<string, unknown>) => boolean;
  showToast: (text: string, ok: boolean) => void;
}

export default function GamePlayerRoomControls({
  show,
  roomToken,
  gameId,
  onClose,
  sendDC,
  showToast,
}: GamePlayerRoomControlsProps) {
  if (!show) return null;

  return (
    <>
      <div className={styles.backdrop} onClick={onClose} />
      <div className={styles.roomPanel}>
        <div className={styles.slotHeader}>
          <span>Room</span>
          <Button variant="ghost" onClick={onClose}>✕</Button>
        </div>
        <div className={styles.roomGrid}>
          <Button variant="secondary" size="sm" onClick={() => { sendDC({ cmd: "reset" }); showToast("Reset", true); }}>
            ↺ Reset
          </Button>
          <Button variant="secondary" size="sm" onClick={() => { sendDC({ cmd: "save_state", slot: 1 }); showToast("Saved slot 1", true); }}>
            💾 Quick Save
          </Button>
          <Button variant="secondary" size="sm" onClick={() => { sendDC({ cmd: "load_state", slot: 1 }); showToast("Loaded slot 1", true); }}>
            📂 Quick Load
          </Button>
          <Button variant="secondary" size="sm" onClick={() => { sendDC({ cmd: "disk_eject" }); showToast("Disk ejected", true); }}>
            💿 Eject
          </Button>
          <Button variant="secondary" size="sm" onClick={() => { sendDC({ cmd: "disk_insert", index: 0 }); showToast("Disk 0 inserted", true); }}>
            💿 Insert 0
          </Button>
          {roomToken && (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                const url = `${window.location.origin}/play/${gameId}?join=${roomToken}`;
                navigator.clipboard.writeText(url).then(
                  () => showToast("Share link copied!", true),
                  () => showToast("Copy failed", false)
                );
              }}
            >
              🔗 Share Link
            </Button>
          )}
        </div>
      </div>
    </>
  );
}
