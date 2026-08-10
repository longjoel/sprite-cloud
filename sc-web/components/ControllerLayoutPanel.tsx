"use client";

import { useState } from "react";
import { Button, Stack, Typography } from "@mui/material";
import styles from "./ControllerLayoutPanel.module.css";

interface ControllerLayoutApi {
  getOpacity?: () => "low" | "medium" | "high" | "max";
  setOpacity: (opacity: "low" | "medium" | "high" | "max") => void;
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
  <Button
    key={value}
    variant="outlined"
    className={styles.choice}
    onClick={() => action(value)}
    disabled={disabled}
    aria-pressed={selected === undefined ? undefined : selected === value}
  >
    {value[0].toUpperCase() + value.slice(1)}
  </Button>
));

export default function ControllerLayoutPanel({
  controller,
  onBack,
  onClose,
  onCustomize,
  onHide,
}: ControllerLayoutPanelProps) {
  const [opacity, setOpacity] = useState<"low" | "medium" | "high" | "max" | undefined>(
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
          <Button variant="text" className={styles.headerButton} onClick={onBack}>← Options</Button>
          <Typography component="h2">Controller Layout</Typography>
          <Button variant="text" className={styles.headerButton} onClick={onClose} aria-label="Close Controller Layout">✕ Close</Button>
        </header>

        <div className={styles.section}>
          <h3>Opacity</h3>
          <div className={styles.choices}>
            {choices(["low", "medium", "high", "max"] as const, (value) => {
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

        <Stack className={styles.actions} spacing={1}>
          <Button variant="contained" onClick={onCustomize}>Customize Position</Button>
          <Button variant="outlined" disabled={unavailable} onClick={() => controller?.exitEditMode()}>Lock Layout</Button>
          <Button variant="outlined" disabled={unavailable} onClick={() => controller?.resetLayout()}>Reset Layout</Button>
          <Button variant="outlined" disabled={unavailable} onClick={() => controller?.swapAB()}>Swap A/B</Button>
          <Button variant="text" onClick={onHide}>Hide Controls</Button>
        </Stack>
        {!controller && <Typography className={styles.hint} color="text.secondary">Show the touch controls to edit their layout.</Typography>}
      </section>
    </div>
  );
}
