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
    background: "var(--color-brass)",
    color: "var(--color-mahogany)",
    border: "1px solid var(--color-brass)",
  },
  secondary: {
    background: "var(--color-walnut)",
    color: "var(--color-cream)",
    border: "1px solid var(--color-bamboo)",
  },
  ghost: {
    background: "none",
    color: "var(--color-muted)",
    border: "none",
    padding: 0,
  },
  destructive: {
    background: "var(--color-errorBg)",
    color: "var(--color-error)",
    border: "1px solid var(--color-error)",
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
        borderRadius: "var(--radius-sm)",
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
