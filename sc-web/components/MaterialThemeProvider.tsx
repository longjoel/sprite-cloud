"use client";

import { ThemeProvider, createTheme } from "@mui/material";
import { tokens } from "@/lib/design-tokens";

// ── Sprite Cloud Material theme — consumes canonical design tokens ────

const theme = createTheme({
  palette: {
    mode: "dark",
    background: { default: tokens.surface.deep, paper: tokens.surface.mid },
    text: { primary: tokens.text.primary, secondary: tokens.text.secondary },
    primary: { main: tokens.accent.main },
    error: { main: tokens.pixel.red },
    warning: { main: tokens.pixel.yellow },
    success: { main: tokens.pixel.green },
    info: { main: tokens.accent.main },
  },
  shape: { borderRadius: parseInt(tokens.radius.sm) },
  typography: {
    fontFamily: tokens.font.sans.replace(/'/g, ""),
    fontSize: parseInt(tokens.font.size.base),
    button: {
      textTransform: "none",
      fontFamily: tokens.font.mono.replace(/'/g, ""),
    },
  },
});

export default function MaterialThemeProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <ThemeProvider theme={theme}>
      {children}
    </ThemeProvider>
  );
}
