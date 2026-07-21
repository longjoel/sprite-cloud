"use client";

import type { ButtonHTMLAttributes } from "react";

type Variant = "primary" | "secondary" | "ghost" | "destructive";
type Size = "sm" | "md" | "lg";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
}

const variantStyles: Record<Variant, React.CSSProperties> = {
  primary: {
    background: "var(--color-accent)",
    color: "var(--color-bg-deep)",
    border: "1px solid var(--color-accent)",
  },
  secondary: {
    background: "var(--color-surface-raised)",
    color: "var(--color-text-primary)",
    border: "1px solid var(--color-border-default)",
  },
  ghost: {
    background: "none",
    color: "var(--color-text-secondary)",
    border: "none",
    padding: 0,
  },
  destructive: {
    background: "rgba(239,68,68,0.15)",
    color: "#ef4444",
    border: "1px solid #ef4444",
  },
};

const sizeStyles: Record<Size, React.CSSProperties> = {
  sm: { padding: "2px 10px", fontSize: "var(--font-size-sm)" },
  md: { padding: "4px 14px", fontSize: "var(--font-size-base)" },
  lg: { padding: "8px 24px", fontSize: "var(--font-size-md)" },
};

export default function Button({
  variant = "secondary",
  size = "md",
  style,
  children,
  ...rest
}: ButtonProps) {
  return (
    <button
      style={{
        fontFamily: "var(--font-mono)",
        cursor: "pointer",
        borderRadius: "2px",
        transition: "opacity 0.15s",
        ...variantStyles[variant],
        ...sizeStyles[size],
        ...style,
      }}
      {...rest}
    >
      {children}
    </button>
  );
}
