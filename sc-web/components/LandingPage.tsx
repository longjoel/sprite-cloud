"use client";

import { useState } from "react";
import Link from "next/link";
import WallClient from "@/components/WallClient";
import FeaturedLive from "@/components/FeaturedLive";
import styles from "./LandingPage.module.css";

// ── LandingPage — the Living Cabinet wall

const CLOUD_ACCENT = "#38bdf8";

interface LandingPageProps {
  userName?: string | null;
  authenticated?: boolean;
}

const CTA_LINKS = [
  { label: "Make your own account", href: "/help", primary: true },
  { label: "Check out the code on GitHub", href: "https://github.com/longjoel/sprite-cloud" },
  { label: "Join the Discord", href: "https://discord.gg/zujXa48kyS" },
  { label: "Read the blog", href: "https://lngnckr.tech/" },
];

const SOCIAL_LINKS = [
  { label: "Bluesky", href: "https://bsky.app/profile/jlonganecker.bsky.social" },
  { label: "Twitter / X", href: "https://x.com/J_Longanecker" },
  { label: "YouTube", href: "https://www.youtube.com/@JoelLonganecker" },
];

export default function LandingPage({ authenticated = false }: LandingPageProps) {
  const [cookieDismissed, setCookieDismissed] = useState(false);
  const [featuredKey, setFeaturedKey] = useState<string | null>(null);

  return (
    <main className={styles.page}>
      <nav className={styles.nav}>
        <Link href="/" className={styles.logo}>Sprite Cloud</Link>
        <div style={{ display: "flex", gap: 16, alignItems: "center" }}>
          <Link href="/help" className={styles.navLink}>Help</Link>
          {authenticated ? (
            <>
              <Link href="/library" className={styles.navLink}>Library</Link>
              <Link href="/servers" className={styles.navLink}>Dashboard</Link>
              <Link href="/api/auth/signout" className={styles.navLink}>Sign out</Link>
            </>
          ) : (
            <Link href="/signin?callbackUrl=/library" className={styles.navLink}>Sign In →</Link>
          )}
        </div>
      </nav>

      <div className={styles.layout}>
        <section className={styles.machines} aria-labelledby="active-machines-heading">
          <h1 id="active-machines-heading" className={styles.machinesHeading}>Active machines</h1>
          <p className={styles.machinesSubheading}>
            Live games streaming from servers on this gateway right now.
          </p>
          <FeaturedLive onFeatured={setFeaturedKey} />
          <WallClient excludeKey={featuredKey} />
        </section>

        <aside className={styles.onboarding} aria-labelledby="welcome-heading">
          <p className={styles.eyebrow}>The arcade is open</p>
          <h2 id="welcome-heading" className={styles.title}>
            Play from anywhere.
            <br />
            <span style={{ color: CLOUD_ACCENT }}>Use your hardware.</span>
          </h2>
          <p className={styles.subtitle}>
            Sprite Cloud streams your games from your own machine to any browser.
            No subscription, no cloud lock-in — just your ROMs, your rules.
          </p>

          <div className={styles.ctaList}>
            {CTA_LINKS.map((cta) => (
              <a
                key={cta.label}
                href={cta.href}
                className={`${styles.cta}${cta.primary ? ` ${styles.ctaPrimary}` : ""}`}
                {...(cta.href.startsWith("http") ? { target: "_blank", rel: "noopener noreferrer" } : {})}
              >
                <span>{cta.label}</span>
                <span className={styles.ctaArrow} aria-hidden="true">→</span>
              </a>
            ))}
          </div>

          <p className={styles.socialHeading}>Follow along</p>
          <div className={styles.socials}>
            {SOCIAL_LINKS.map((social) => (
              <a key={social.label} href={social.href} target="_blank" rel="noopener noreferrer" className={styles.socialLink}>
                {social.label}
              </a>
            ))}
          </div>
        </aside>
      </div>

      <footer className={styles.footer}>
        <div className={styles.footerCol}>
          <span className={styles.footerText}>Sprite Cloud</span>
          <span className={styles.footerDim}>self-hosted game streaming</span>
        </div>
        <div className={styles.footerLinks}>
          <span className={styles.footerDim}>© {new Date().getFullYear()} Sprite Cloud</span>
          <span className={styles.footerDot}>·</span>
          <Link href="/help" className={styles.footerLink}>Setup Guide</Link>
          <span className={styles.footerDot}>·</span>
          <a href="https://github.com/longjoel/sprite-cloud" target="_blank" rel="noopener noreferrer" className={styles.footerLink}>Source</a>
        </div>
      </footer>

      {!cookieDismissed && (
        <div className={styles.cookieBanner}>
          <span className={styles.cookieText}>
            This site uses a session cookie for authentication. No tracking, no ads, no third-party cookies.
          </span>
          <button onClick={() => setCookieDismissed(true)} className={styles.cookieBtn}>OK</button>
        </div>
      )}
    </main>
  );
}
