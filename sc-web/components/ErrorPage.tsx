"use client";

import Link from "next/link";
import { Box, Button, Typography } from "@mui/material";

interface ErrorPageAction {
  label: string;
  href?: string;
  onClick?: () => void;
}

interface ErrorPageProps {
  code: number;
  title: string;
  message: string;
  action?: ErrorPageAction;
}

/** Generate a short diagnostic ID from the error context. */
function diagnosticId(code: number): string {
  const ts = Date.now().toString(36).slice(-4);
  return `ERR-${code}-${ts}`;
}

export function ErrorPage({ code, title, message, action }: ErrorPageProps) {
  const diagId = diagnosticId(code);

  return (
    <Box
      sx={{
        minHeight: "100vh",
        p: 3,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        textAlign: "center",
        gap: 1,
      }}
    >
      <Typography variant="h1" color="primary" sx={{ lineHeight: 1, mb: 1 }}>
        {code}
      </Typography>
      <Typography variant="h5" component="h1" gutterBottom>
        {title}
      </Typography>
      <Typography color="text.secondary" sx={{ maxWidth: 420, mb: 2 }}>
        {message}
      </Typography>
      <Typography variant="caption" color="text.disabled" sx={{ mb: 2 }}>
        {diagId}
      </Typography>

      {action?.onClick ? (
        <Button type="button" onClick={action.onClick} variant="outlined">
          {action.label}
        </Button>
      ) : action?.href ? (
        <Button component={Link} href={action.href} variant="outlined">
          {action.label}
        </Button>
      ) : (
        <Button component={Link} href="/" variant="outlined">
          Go home
        </Button>
      )}
    </Box>
  );
}
