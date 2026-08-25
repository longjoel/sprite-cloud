"use client";

import { useEffect, useRef, useState } from "react";
import styles from "./PreImmersiveHint.module.css";

/** True when a physical gamepad is currently connected. Safe without the API. */
function gamepadConnectedNow(): boolean {
  try {
    const pads = navigator.getGamepads?.();
    if (!pads) return false;
    for (let i = 0; i < pads.length; i += 1) {
      if (pads[i]) return true;
    }
  } catch {
    return false;
  }
  return false;
}

export interface PreImmersiveHintProps {
  /** Whether the hint should currently be shown (pre-immersive Room view). */
  open: boolean;
  /** Dismiss the hint for the rest of the session (button or auto-close). */
  onDismiss: () => void;
}

/**
 * Pre-immersive invitation in the Room view: tells the player to double-tap to
 * play, and (when no gamepad is attached) to plug one in first. The hint
 * auto-dismisses the moment a gamepad is detected, so a connected controller
 * closes the modal without any extra tap.
 */
export default function PreImmersiveHint({ open, onDismiss }: PreImmersiveHintProps) {
  const [gamepadConnected, setGamepadConnected] = useState<boolean>(() => gamepadConnectedNow());
  const onDismissRef = useRef(onDismiss);
  useEffect(() => {
    onDismissRef.current = onDismiss;
  }, [onDismiss]);

  useEffect(() => {
    const onGamepad = () => {
      setGamepadConnected(true);
      onDismissRef.current();
    };
    const id = setInterval(() => {
      if (gamepadConnectedNow()) onGamepad();
    }, 1000);
    window.addEventListener("gamepadconnected", onGamepad);
    return () => {
      window.clearInterval(id);
      window.removeEventListener("gamepadconnected", onGamepad);
    };
  }, []);

  if (!open) return null;

  return (
    <div className={styles.hintLayer} role="status" aria-live="polite">
      <div className={styles.hintCard}>
        <button
          type="button"
          className={styles.dismiss}
          aria-label="Dismiss hint"
          title="Dismiss"
          onClick={onDismiss}
        >
          ✕
        </button>
        <strong className={styles.title}>Double-tap to play</strong>
        {!gamepadConnected && (
          <span className={styles.sub}>Plug in your gamepad now, then double-tap.</span>
        )}
      </div>
    </div>
  );
}