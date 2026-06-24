// ── Health card component ──────────────────────────────────────────────

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
        ...S.healthCard,
        borderColor: ok ? "var(--color-success)" : "var(--color-error)",
      }}
    >
      <div style={S.healthLabel}>{label}</div>
      <div
        style={{
          ...S.healthValue,
          color: ok ? "var(--color-cream)" : "var(--color-error)",
        }}
      >
        {value}
      </div>
      {warn && <div style={S.healthWarn}>{warn}</div>}
    </div>
  );
}

// ── Styles (shared with dashboard page) ────────────────────────────────

const S: Record<string, React.CSSProperties> = {
  healthCard: {
    border: "1px solid var(--color-bamboo)",
    padding: "var(--space-4) var(--space-6)",
    borderRadius: "var(--radius-md)",
    minWidth: 110,
    background: "var(--color-teak)",
  },
  healthLabel: {
    fontSize: "var(--font-size-xs)",
    color: "var(--color-muted)",
    marginBottom: "var(--space-2)",
    fontFamily: "var(--font-mono)",
  },
  healthValue: {
    fontSize: "var(--font-size-lg)",
    fontFamily: "var(--font-mono)",
    fontWeight: 600,
  },
  healthWarn: {
    marginTop: "var(--space-2)",
    fontSize: "var(--font-size-xs)",
    color: "var(--color-warning)",
    fontFamily: "var(--font-mono)",
  },
};
