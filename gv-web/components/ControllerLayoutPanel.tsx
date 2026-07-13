"use client";

import { useState } from "react";
import styles from "./ControllerLayoutPanel.module.css";

export interface ControllerLayoutApi {
  getOpacity?: () => "low" | "medium" | "high";
  setOpacity: (opacity: "low" | "medium" | "high") => void;
  getSizePreset?: () => "compact" | "standard" | "large" | "custom";
  setSizePreset: (size: "compact" | "standard" | "large") => void;
  swapAB: () => void;
  resetLayout: () => void;
  exitEditMode: () => void;
}

interface ControllerLayoutPanelProps {
  controller?: ControllerLayoutApi;
  onBack: () => void;
  onClose: () => void;
  onCustomize: () => void;
  onHide: () => void;
}

const choices = <T extends string>(
  values: readonly T[],
  action: (value: T) => void,
  disabled: boolean,
  selected: string | undefined,
) => values.map((value) => (
  <button
    key={value}
    className={styles.choice}
    onClick={() => action(value)}
    disabled={disabled}
    aria-pressed={selected === undefined ? undefined : selected === value}
  >
    {value[0].toUpperCase() + value.slice(1)}
  </button>
));

export default function ControllerLayoutPanel({
  controller,
  onBack,
  onClose,
  onCustomize,
  onHide,
}: ControllerLayoutPanelProps) {
  const [opacity, setOpacity] = useState<"low" | "medium" | "high" | undefined>(
    () => controller?.getOpacity?.(),
  );
  const [size, setSize] = useState<"compact" | "standard" | "large" | "custom" | undefined>(
    () => controller?.getSizePreset?.(),
  );
  const unavailable = !controller;

  return (
    <div className={styles.backdrop} onClick={onClose}>
      <section
        className={styles.panel}
        data-player-panel
        role="dialog"
        aria-modal="true"
        aria-label="Controller Layout"
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
      >
        <header className={styles.header}>
          <button className={styles.headerButton} onClick={onBack}>← Options</button>
          <h2>Controller Layout</h2>
          <button className={styles.headerButton} onClick={onClose} aria-label="Close Controller Layout">✕</button>
        </header>

        <div className={styles.section}>
          <h3>Opacity</h3>
          <div className={styles.choices}>
            {choices(["low", "medium", "high"] as const, (value) => {
              controller?.setOpacity(value);
              setOpacity(value);
            }, unavailable, opacity)}
          </div>
        </div>

        <div className={styles.section}>
          <h3>Control Size</h3>
          <div className={styles.choices}>
            {choices(["compact", "standard", "large"] as const, (value) => {
              controller?.setSizePreset(value);
              setSize(value);
            }, unavailable, size)}
          </div>
        </div>

        <div className={styles.actions}>
          <button onClick={onCustomize}>Customize Position</button>
          <button disabled={unavailable} onClick={() => controller?.exitEditMode()}>Lock Layout</button>
          <button disabled={unavailable} onClick={() => controller?.resetLayout()}>Reset Layout</button>
          <button disabled={unavailable} onClick={() => controller?.swapAB()}>Swap A/B</button>
          <button onClick={onHide}>Hide Controls</button>
        </div>
        {!controller && <p className={styles.hint}>Show the touch controls to edit their layout.</p>}
      </section>
    </div>
  );
}
