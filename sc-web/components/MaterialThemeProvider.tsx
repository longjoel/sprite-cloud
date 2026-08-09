"use client";

import { CssBaseline, ThemeProvider, createTheme } from "@mui/material";

// Keep the first rebuild intentionally close to Material defaults. Brand
// decisions belong in a later design pass, not in every page component.
const theme = createTheme({
  palette: {
    mode: "dark",
  },
});

export default function MaterialThemeProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      {children}
    </ThemeProvider>
  );
}
