"use client";

type Variant = "success" | "warning" | "error" | "info" | "muted";

interface BadgeProps {
  children: React.ReactNode;
  variant?: Variant;
  title?: string;
}

const variantStyles: Record<Variant, React.CSSProperties> = {
  success: {
    background: "var(--color-successBg)",
    color: "var(--color-success)",
  },
  warning: {
    background: "var(--color-warningBg)",
    color: "var(--color-warning)",
  },
  error: {
    background: "var(--color-errorBg)",
    color: "var(--color-error)",
  },
  info: {
    background: "var(--color-infoBg)",
    color: "var(--color-info)",
  },
  muted: {
    background: "var(--color-walnut)",
    color: "var(--color-muted)",
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
        fontSize: "var(--font-size-xs)",
        padding: "1px 6px",
        borderRadius: "var(--radius-sm)",
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
