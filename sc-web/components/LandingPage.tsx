"use client";

import { useState } from "react";
import {
  Box,
  Link as MuiLink,
  Stack,
  Typography,
} from "@mui/material";
import AppHeader from "@/components/fluent/AppHeader";
import WallClient from "@/components/WallClient";
import FeaturedLive from "@/components/FeaturedLive";
import LegalFooter from "@/components/LegalFooter";
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
  const [featuredKey, setFeaturedKey] = useState<string | null>(null);

  return (
    <Box component="main" className={styles.page}>
      <AppHeader userName={userName} authenticated={authenticated} />

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

      <LegalFooter />
    </Box>
  );
}
