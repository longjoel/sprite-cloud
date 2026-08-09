"use client";

import { useState } from "react";
import Link from "next/link";
import {
  Alert,
  Box,
  Button,
  Container,
  Link as MuiLink,
  Snackbar,
  Stack,
  Typography,
} from "@mui/material";
import AppHeader from "@/components/fluent/AppHeader";
import WallClient from "@/components/WallClient";
import FeaturedLive from "@/components/FeaturedLive";

// ── LandingPage — the public Sprite Cloud arcade ──────────────────────

interface LandingPageProps {
  userName?: string | null;
  authenticated?: boolean;
}

export default function LandingPage({ userName, authenticated = false }: LandingPageProps) {
  const [cookieDismissed, setCookieDismissed] = useState(false);
  const [featuredKey, setFeaturedKey] = useState<string | null>(null);

  const links = authenticated
    ? [
        { label: "Library", href: "/library" },
        { label: "Dashboard", href: "/servers" },
        { label: "Help", href: "/help" },
        { label: "Sign out", href: "/api/auth/signout" },
      ]
    : [
        { label: "Help", href: "/help" },
        { label: "Sign in", href: "/signin?callbackUrl=/library" },
      ];

  return (
    <Box component="main" sx={{ minHeight: "100vh", display: "flex", flexDirection: "column" }}>
      <AppHeader userName={userName} links={links} />

      <Container component="section" maxWidth="md" sx={{ py: { xs: 6, sm: 8 }, textAlign: "center" }}>
        <Typography variant="h1" gutterBottom>
          The Arcade is open.
        </Typography>
        <Typography color="text.secondary" sx={{ maxWidth: 640, mx: "auto" }}>
          Live games streaming from servers on this gateway right now. No account, no install:
          choose a live game and you&apos;re in the seat.
        </Typography>
      </Container>

      <FeaturedLive onFeatured={setFeaturedKey} />
      <WallClient excludeKey={featuredKey} />

      <Box component="footer" sx={{ mt: "auto", borderTop: 1, borderColor: "divider", py: 3 }}>
        <Container maxWidth="lg">
          <Stack
            direction={{ xs: "column", sm: "row" }}
            spacing={2}
            sx={{
              alignItems: { xs: "flex-start", sm: "center" },
              justifyContent: "space-between",
            }}
          >
            <Box>
              <Typography variant="overline" color="primary" sx={{ display: "block" }}>
                Sprite Cloud
              </Typography>
              <Typography variant="caption" color="text.secondary">
                Self-hosted game streaming
              </Typography>
            </Box>
            <Stack
              direction="row"
              spacing={1}
              useFlexGap
              sx={{ flexWrap: "wrap", alignItems: "center" }}
            >
              <Typography variant="caption" color="text.secondary">
                © {new Date().getFullYear()} Sprite Cloud
              </Typography>
              <Typography variant="caption" color="text.disabled">·</Typography>
              <MuiLink component={Link} href="/help" variant="caption" underline="hover">
                Setup guide
              </MuiLink>
              <Typography variant="caption" color="text.disabled">·</Typography>
              <MuiLink
                href="https://github.com/longjoel/sprite-cloud"
                target="_blank"
                rel="noopener noreferrer"
                variant="caption"
                underline="hover"
              >
                Source
              </MuiLink>
              <Typography variant="caption" color="text.disabled">·</Typography>
              <MuiLink
                href="https://discord.gg/zujXa48kyS"
                target="_blank"
                rel="noopener noreferrer"
                variant="caption"
                underline="hover"
              >
                Discord
              </MuiLink>
            </Stack>
          </Stack>
        </Container>
      </Box>

      <Snackbar
        open={!cookieDismissed}
        onClose={() => setCookieDismissed(true)}
        anchorOrigin={{ vertical: "bottom", horizontal: "center" }}
      >
        <Alert
          severity="info"
          variant="outlined"
          onClose={() => setCookieDismissed(true)}
          action={
            <Button color="inherit" size="small" onClick={() => setCookieDismissed(true)}>
              OK
            </Button>
          }
        >
          This site uses a session cookie for authentication. No tracking, ads, or third-party cookies.
        </Alert>
      </Snackbar>
    </Box>
  );
}
