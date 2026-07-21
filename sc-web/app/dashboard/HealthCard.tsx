// ── Health card component — Metro style ────────────────────────────

import React from "react";

interface HealthCardProps {
  label: string;
  value: string;
  ok: boolean;
  warn?: string;
}

export default function HealthCard({ label, value, ok, warn }: HealthCardProps) {
  return (
    <div
      style={{
        border: `2px solid ${ok ? "var(--color-success)" : "var(--color-error)"}`,
        padding: "12px 20px",
        borderRadius: "var(--radius-sm)",
        minWidth: 120,
        background: ok ? "var(--color-successBg)" : "var(--color-errorBg)",
      }}
    >
      <div style={S.label}>{label}</div>
      <div
        style={{
          ...S.value,
          color: ok ? "var(--color-success)" : "var(--color-error)",
        }}
      >
        {value}
      </div>
      {warn && <div style={S.warn}>{warn}</div>}
    </div>
  );
}

const S: Record<string, React.CSSProperties> = {
  label: {
    fontSize: "var(--font-size-xs)",
    color: "var(--color-cloud-dim)",
    marginBottom: "var(--space-2)",
    fontFamily: "var(--font-mono)",
    textTransform: "uppercase",
    letterSpacing: "0.05em",
  },
  value: {
    fontSize: "var(--font-size-lg)",
    fontFamily: "var(--font-mono)",
    fontWeight: 700,
  },
  warn: {
    marginTop: "var(--space-2)",
    fontSize: "var(--font-size-xs)",
    color: "var(--color-warning)",
    fontFamily: "var(--font-mono)",
  },
};
