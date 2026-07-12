"use client";

import { useEffect } from "react";

const BUTTON_LABELS: Record<number, string> = {
  0: "B", 1: "Y", 2: "Select", 3: "Start", 4: "Up", 5: "Down",
  6: "Left", 7: "Right", 8: "A", 9: "X", 10: "L", 11: "R",
  12: "L2", 13: "R2", 14: "L3", 15: "R3",
};

const remapStyles: Record<string, React.CSSProperties> = {
  panel: {
    position: "absolute",
    top: "50%",
    left: "50%",
    transform: "translate(-50%, -50%)",
    background: "rgba(0,0,0,0.95)",
    border: "1px solid var(--color-border-default)",
    borderRadius: "2px",
    padding: "var(--space-6)",
    zIndex: 27,
    maxWidth: 380,
    width: "90vw",
  },
  header: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: "var(--space-4)",
    fontFamily: "var(--font-mono)",
    fontSize: "var(--font-size-sm)",
    color: "var(--color-text-secondary)",
  },
  waiting: {
    textAlign: "center" as const,
    fontFamily: "var(--font-mono)",
    fontSize: "var(--font-size-sm)",
    color: "var(--color-accent)",
    marginBottom: "var(--space-3)",
  },
  grid: {
    display: "grid",
    gridTemplateColumns: "1fr 1fr",
    gap: "var(--space-2)",
  },
  cell: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: "var(--space-2) var(--space-3)",
    background: "var(--color-surface-raised)",
    border: "1px solid var(--color-border-default)",
    borderRadius: "2px",
    color: "var(--color-text-primary)",
    cursor: "pointer",
    fontFamily: "var(--font-mono)",
    fontSize: "var(--font-size-xs)",
  },
  cellLabel: { fontWeight: 600 },
  cellKey: { color: "var(--color-accent)", fontSize: 10 },
  resetBtn: {
    background: "none",
    border: "1px solid var(--color-border-default)",
    borderRadius: "2px",
    color: "var(--color-text-secondary)",
    cursor: "pointer",
    fontSize: 10,
    padding: "2px 6px",
    fontFamily: "var(--font-mono)",
  },
  closeBtn: {
    background: "none",
    border: "none",
    color: "var(--color-text-secondary)",
    cursor: "pointer",
    fontSize: 14,
  },
};

export default function RemapPanel({
  playerRef,
  waiting,
  setWaiting,
  onClose,
  onBack,
}: {
  playerRef: React.RefObject<any>;
  waiting: string | null;
  setWaiting: (v: string | null) => void;
  onClose: () => void;
  onBack: () => void;
}) {
  const mapping = playerRef.current?.getKeyMapping?.() || {};

  // Build reverse map: bit → [keys]
  const bitKeys: Record<number, string[]> = {};
  for (const [key, bit] of Object.entries(mapping)) {
    const b = bit as number;
    if (!bitKeys[b]) bitKeys[b] = [];
    bitKeys[b].push(key);
  }

  // Listen for next keypress when waiting
  useEffect(() => {
    if (!waiting) return;
    const handler = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const bit = parseInt(waiting);
      if (playerRef.current?.setKeyMapping) {
        playerRef.current.setKeyMapping(e.key, bit);
      }
      setWaiting(null);
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [waiting, playerRef, setWaiting]);

  return (
    <div style={remapStyles.panel}>
      <div style={remapStyles.header}>
        <button style={remapStyles.resetBtn} onClick={onBack}>← Options</button>
        <span>Key Mapping</span>
        <div style={{ display: "flex", gap: "var(--space-3)" }}>
          <button
            style={remapStyles.resetBtn}
            onClick={() => {
              playerRef.current?.resetKeymap?.();
              onClose();
            }}
          >
            Reset defaults
          </button>
          <button style={remapStyles.closeBtn} onClick={onClose}>
            ✕
          </button>
        </div>
      </div>
      {waiting && (
        <p style={remapStyles.waiting}>
          Press a key for {BUTTON_LABELS[parseInt(waiting)] || `bit ${waiting}`}…
        </p>
      )}
      <div style={remapStyles.grid}>
        {Object.entries(BUTTON_LABELS).map(([bitStr, label]) => {
          const bit = parseInt(bitStr);
          const keys = bitKeys[bit] || [];
          return (
            <button
              key={bit}
              style={{
                ...remapStyles.cell,
                outline:
                  waiting === bitStr
                    ? "2px solid var(--color-accent)"
                    : undefined,
              }}
              onClick={() => setWaiting(bitStr)}
            >
              <span style={remapStyles.cellLabel}>{label}</span>
              <span style={remapStyles.cellKey}>
                {keys.length > 0 ? keys.slice(0, 3).join(", ") : "—"}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
