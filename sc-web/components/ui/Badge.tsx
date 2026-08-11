"use client";

import { Chip } from "@mui/material";

type Variant = "success" | "warning" | "error" | "info" | "muted";

interface BadgeProps {
  children: React.ReactNode;
  variant?: Variant;
  title?: string;
}

const chipColors: Record<Variant, "success" | "warning" | "error" | "info" | "default"> = {
  success: "success",
  warning: "warning",
  error: "error",
  info: "info",
  muted: "default",
};

export default function Badge({ children, variant = "muted", title }: BadgeProps) {
  return (
    <Chip
      component="span"
      label={children}
      title={title}
      color={chipColors[variant]}
      size="small"
      variant="outlined"
      sx={{
        height: 24,
        borderRadius: 1,
        fontSize: "0.7rem",
        fontWeight: 600,
        letterSpacing: "0.04em",
        textTransform: "uppercase",
        whiteSpace: "nowrap",
      }}
    />
  );
}
