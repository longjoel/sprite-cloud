"use client";

import { useState } from "react";
import { Alert, Box, Button, Link, Paper, Stack, Typography } from "@mui/material";
import { csrfHeaders } from "./dashboard-utils";

export default function PairingPrompt() {
  const [code, setCode] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function generate() {
    setLoading(true);
    setCode(null);
    setError(null);
    try {
      const res = await fetch("/api/auth/pair/generate", { method: "POST", headers: csrfHeaders() });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      setCode(body.code);
    } catch (e: any) {
      setError(e.message || "Pairing failed");
    } finally {
      setLoading(false);
    }
  }

  const origin = typeof window !== "undefined" ? window.location.origin : "";
  const releaseUrl = "https://github.com/longjoel/sprite-cloud/releases/latest";
  const installOneLiner = "curl -fsSL https://sprite-cloud.com/install.sh | bash";

  return (
    <Stack spacing={3} sx={{ mt: 2 }}>
      <Box>
        <Typography variant="h6" gutterBottom>1. Install sc-server</Typography>
        <Typography variant="body2" color="text.secondary">
          Run this on your gaming machine:
        </Typography>
        <CodeSurface accent>{installOneLiner}</CodeSurface>
        <Typography variant="body2" color="text.secondary">
          Or grab the binary from{" "}
          <Link href={releaseUrl} target="_blank" rel="noopener">
            GitHub Releases
          </Link>{" "}
          and place it in your PATH.
        </Typography>
      </Box>

      <Box>
        <Typography variant="h6" gutterBottom>2. Pair with your account</Typography>
        <Button type="button" variant="contained" onClick={generate} disabled={loading}>
          {loading ? "Generating…" : "Generate Pairing Code"}
        </Button>
      </Box>

      {code && (
        <Box>
          <Typography variant="body2" color="text.secondary">
            Run this on your gaming machine:
          </Typography>
          <CodeSurface accent>{`sc-server pair ${code} --sc-web-url ${origin}`}</CodeSurface>
        </Box>
      )}

      {error && <Alert severity="error">{error}</Alert>}

      <Box>
        <Typography variant="h6" gutterBottom>3. You&apos;re done</Typography>
        <Typography variant="body2" color="text.secondary" sx={{ lineHeight: 1.6 }}>
          Refresh this page. Your server appears in the list below.
          Place ROMs in the directory you configured and they&apos;ll be scanned automatically.
        </Typography>
      </Box>
    </Stack>
  );
}

function CodeSurface({ children, accent = false }: { children: React.ReactNode; accent?: boolean }) {
  return (
    <Paper
      component="pre"
      variant="outlined"
      sx={{
        my: 1,
        p: 1.5,
        overflowX: "auto",
        whiteSpace: "pre-wrap",
        wordBreak: "break-all",
        fontFamily: "monospace",
        fontSize: "0.875rem",
        color: accent ? "primary.main" : "text.primary",
        borderColor: accent ? "primary.main" : "divider",
        bgcolor: "background.default",
      }}
    >
      {children}
    </Paper>
  );
}
