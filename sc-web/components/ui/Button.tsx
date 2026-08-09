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

const sizeStyles = {
  sm: { minHeight: 36, px: 1.25, py: 0.25, fontSize: "0.8125rem" },
  md: { minHeight: 44, px: 1.75, py: 0.5, fontSize: "0.875rem" },
  lg: { minHeight: 44, px: 3, py: 1, fontSize: "1rem" },
} as const;

export default function Button({
  variant = "secondary",
  size = "md",
  sx,
  ...rest
}: ButtonProps) {
  return (
    <MuiButton
      variant={variant === "primary" || variant === "destructive" ? "contained" : "outlined"}
      color={variantMap[variant]}
      sx={[
        {
          borderRadius: 1,
          textTransform: "none",
          ...sizeStyles[size],
          ...(variant === "ghost"
            ? {
                borderColor: "transparent",
                color: "text.secondary",
                "&:hover": {
                  borderColor: "divider",
                  backgroundColor: "action.hover",
                },
              }
            : {}),
        },
        ...(Array.isArray(sx) ? sx : [sx]),
      ]}
      {...rest}
    />
  );
}
