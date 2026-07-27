"use client";

import { Button as MuiButton, type ButtonProps as MuiButtonProps } from "@mui/material";

type Variant = "primary" | "secondary" | "ghost" | "destructive";
type Size = "sm" | "md" | "lg";

interface ButtonProps extends Omit<MuiButtonProps, "variant" | "size"> {
  variant?: Variant;
  size?: Size;
}

const variantMap: Record<Variant, MuiButtonProps["color"]> = {
  primary: "primary",
  secondary: "inherit",
  ghost: "inherit",
  destructive: "error",
};

export default function Button({
  variant = "secondary",
  size = "md",
  sx,
  ...rest
}: ButtonProps) {
  const sizeStyles = size === "sm"
    ? { py: 0.25, px: 1.25, fontSize: "var(--font-size-sm)", minHeight: 36 }
    : size === "md"
    ? { py: 0.5, px: 1.75, fontSize: "var(--font-size-base)", minHeight: 44 }
    : { py: 1, px: 3, fontSize: "var(--font-size-md)", minHeight: 44 };

  const ghostStyles = variant === "ghost"
    ? { border: "none", background: "none", color: "var(--color-text-secondary)", "&:hover": { background: "rgba(56,189,248,0.08)" } }
    : {};

  return (
    <MuiButton
      variant={variant === "primary" || variant === "destructive" ? "contained" : "outlined"}
      color={variantMap[variant]}
      sx={{
        fontFamily: "var(--font-mono)",
        textTransform: "none",
        borderRadius: "2px",
        ...sizeStyles,
        ...ghostStyles,
        ...(typeof sx === "function" ? {} : sx),
      }}
      {...rest}
    />
  );
}
