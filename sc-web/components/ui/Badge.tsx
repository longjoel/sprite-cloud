"use client";

type Variant = "success" | "warning" | "error" | "info" | "muted";

interface BadgeProps {
  children: React.ReactNode;
  variant?: Variant;
  title?: string;
}

const variantStyles: Record<Variant, React.CSSProperties> = {
  success: {
    background: "rgba(34,197,94,0.15)",
    color: "#4ade80",
    border: "1px solid rgba(34,197,94,0.3)",
  },
  warning: {
    background: "rgba(250,204,21,0.15)",
    color: "#facc15",
    border: "1px solid rgba(250,204,21,0.3)",
  },
  error: {
    background: "rgba(239,68,68,0.15)",
    color: "#ef4444",
    border: "1px solid rgba(239,68,68,0.3)",
  },
  info: {
    background: "rgba(56,189,248,0.15)",
    color: "#38bdf8",
    border: "1px solid rgba(56,189,248,0.3)",
  },
  muted: {
    background: "var(--color-surface-raised)",
    color: "var(--color-text-secondary)",
    border: "1px solid var(--color-border-default)",
  },
};

export default function Badge({
  children,
  variant = "muted",
  title,
}: BadgeProps) {
  return (
    <span
      title={title}
      style={{
        display: "inline-flex",
        alignItems: "center",
        fontSize: "var(--font-size-xs)",
        padding: "1px 6px",
        borderRadius: "2px",
        fontFamily: "var(--font-mono)",
        fontWeight: 600,
        textTransform: "uppercase",
        whiteSpace: "nowrap",
        ...variantStyles[variant],
      }}
    >
      {children}
    </span>
  );
}
