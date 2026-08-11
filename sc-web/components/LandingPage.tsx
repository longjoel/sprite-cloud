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
import styles from "./LandingPage.module.css";

// ── LandingPage — the public Sprite Cloud arcade ──────────────────────

const CLOUD_ACCENT = "#38bdf8";

interface LandingPageProps {
  userName?: string | null;
  authenticated?: boolean;
}

const CTA_LINKS = [
  { label: "Make your own account", href: "/help#account", primary: true },
  { label: "Check out the code on GitHub", href: "https://github.com/longjoel/sprite-cloud" },
  { label: "Join the Discord", href: "https://discord.gg/zujXa48kyS" },
  { label: "Read the blog", href: "https://lngnckr.tech/" },
];

const SOCIAL_LINKS = [
  { label: "Bluesky", href: "https://bsky.app/profile/jlonganecker.bsky.social" },
  { label: "Twitter / X", href: "https://x.com/J_Longanecker" },
  { label: "YouTube", href: "https://www.youtube.com/@JoelLonganecker" },
];

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
    <Box component="main" className={styles.page}>
      <AppHeader userName={userName} links={links} />

      <Box className={styles.layout}>
        <Box component="section" className={styles.machines} aria-labelledby="active-machines-heading">
          <Typography id="active-machines-heading" component="h1" className={styles.machinesHeading}>
            Active machines
          </Typography>
          <Typography component="p" className={styles.machinesSubheading}>
            Live games streaming from servers on this gateway right now.
          </Typography>
          <FeaturedLive onFeatured={setFeaturedKey} />
          <WallClient excludeKey={featuredKey} />
        </Box>

        <Box component="aside" className={styles.onboarding} aria-labelledby="welcome-heading">
          <Typography component="p" className={styles.eyebrow}>The arcade is open</Typography>
          <Typography id="welcome-heading" component="h2" className={styles.title}>
            Play from anywhere.
            <br />
            <Box component="span" sx={{ color: CLOUD_ACCENT }}>Use your hardware.</Box>
          </Typography>
          <Typography component="p" className={styles.subtitle}>
            Sprite Cloud streams your games from your own machine to any browser.
            No subscription, no cloud lock-in — just your ROMs, your rules.
          </Typography>

          <Box className={styles.ctaList}>
            {CTA_LINKS.map((cta) => (
              <MuiLink
                key={cta.label}
                href={cta.href}
                className={`${styles.cta}${cta.primary ? ` ${styles.ctaPrimary}` : ""}`}
                {...(cta.href.startsWith("http") ? { target: "_blank", rel: "noopener noreferrer" } : {})}
              >
                <span>{cta.label}</span>
                <span className={styles.ctaArrow} aria-hidden="true">→</span>
              </MuiLink>
            ))}
          </Box>

          <Typography component="p" className={styles.socialHeading}>Follow along</Typography>
          <Stack direction="row" className={styles.socials}>
            {SOCIAL_LINKS.map((social) => (
              <MuiLink key={social.label} href={social.href} target="_blank" rel="noopener noreferrer" className={styles.socialLink}>
                {social.label}
              </MuiLink>
            ))}
          </Stack>
        </Box>
      </Box>

      <Box component="footer" sx={{ mt: "auto", borderTop: 1, borderColor: "divider", py: 3 }}>
        <Container maxWidth="lg">
          <Stack
            direction={{ xs: "column", sm: "row" }}
            spacing={2}
            sx={{ alignItems: { xs: "flex-start", sm: "center" }, justifyContent: "space-between" }}
          >
            <Box>
              <Typography variant="overline" color="primary" sx={{ display: "block" }}>Sprite Cloud</Typography>
              <Typography variant="caption" color="text.secondary">Self-hosted game streaming</Typography>
            </Box>
            <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: "wrap", alignItems: "center" }}>
              <Typography variant="caption" color="text.secondary">© {new Date().getFullYear()} Sprite Cloud</Typography>
              <Typography variant="caption" color="text.disabled">·</Typography>
              <MuiLink component={Link} href="/help" variant="caption" underline="hover">Setup guide</MuiLink>
              <Typography variant="caption" color="text.disabled">·</Typography>
              <MuiLink href="https://github.com/longjoel/sprite-cloud" target="_blank" rel="noopener noreferrer" variant="caption" underline="hover">Source</MuiLink>
              <Typography variant="caption" color="text.disabled">·</Typography>
              <MuiLink href="https://discord.gg/zujXa48kyS" target="_blank" rel="noopener noreferrer" variant="caption" underline="hover">Discord</MuiLink>
            </Stack>
          </Stack>
        </Container>
      </Box>

      <Snackbar open={!cookieDismissed} onClose={() => setCookieDismissed(true)} anchorOrigin={{ vertical: "bottom", horizontal: "center" }}>
        <Alert
          severity="info"
          variant="outlined"
          onClose={() => setCookieDismissed(true)}
          action={<Button color="inherit" size="small" onClick={() => setCookieDismissed(true)}>OK</Button>}
        >
          This site uses a session cookie for authentication. No tracking, ads, or third-party cookies.
        </Alert>
      </Snackbar>
    </Box>
  );
}
