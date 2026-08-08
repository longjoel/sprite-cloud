"use client";

import { useState } from "react";
import Link from "next/link";
import WallClient from "@/components/WallClient";
import FeaturedLive from "@/components/FeaturedLive";

// ── LandingPage — the Living Cabinet wall

const CLOUD_ACCENT = "#38bdf8";

interface LandingPageProps {
  userName?: string | null;
  authenticated?: boolean;
}

export default function LandingPage({ userName, authenticated = false }: LandingPageProps) {
  const [cookieDismissed, setCookieDismissed] = useState(false);
  const [featuredKey, setFeaturedKey] = useState<string | null>(null);

  return (
    <main style={s.page}>
      {/* ── Nav bar — auth-aware ─────────────────────────────────────── */}
      <nav style={s.nav}>
        <Link href="/" style={s.logo}>Sprite Cloud</Link>
        <div style={{ display: "flex", gap: 16, alignItems: "center" }}>
          <Link href="/help" style={s.navLink}>Help</Link>
          {authenticated ? (
            <>
              <Link href="/library" style={s.navLink}>Library</Link>
              <Link href="/servers" style={s.navLink}>Dashboard</Link>
              <Link href="/api/auth/signout" style={s.navLink}>Sign out</Link>
            </>
          ) : (
            <>
              <Link href="/help" style={s.navLink}>Help</Link>
              <Link href="/signin?callbackUrl=/library" style={s.navLink}>Sign In →</Link>
            </>
          )}
        </div>
      </nav>

      {/* ── Hero: the living wall ────────────────────────────────────── */}
      <section style={s.hero}>
        <h1 style={s.title}>
          The Arcade
          <br />
          <span style={{ color: CLOUD_ACCENT }}>is open.</span>
        </h1>
        <p style={s.subtitle}>
          Live games streaming from servers on this gateway — right now.
          No account, no install: click a live game and you&apos;re in the seat.
        </p>
      </section>

      {/* ── Live now: rotating hero embed (#781) — excluded from tiles ── */}
      <FeaturedLive onFeatured={setFeaturedKey} />

      {/* ── The Living Cabinet wall (#762) — featured game excluded ──── */}
      <WallClient excludeKey={featuredKey} />

      {/* ── Footer ───────────────────────────────────────────────────── */}
      <footer style={s.footer}>
        <div style={s.footerCol}>
          <span style={s.footerText}>Sprite Cloud</span>
          <span style={s.footerDim}>self-hosted game streaming</span>
        </div>
        <div style={s.footerLinks}>
          <span style={s.footerDim}>© {new Date().getFullYear()} Sprite Cloud</span>
          <span style={s.footerDot}>·</span>
          <Link href="/help" style={s.footerLink}>Setup Guide</Link>
          <span style={s.footerDot}>·</span>
          <a href="https://github.com/longjoel/sprite-cloud" target="_blank" rel="noopener noreferrer" style={s.footerLink}>Source</a>
          <span style={s.footerDot}>·</span>
          <a href="https://discord.gg/zujXa48kyS" target="_blank" rel="noopener noreferrer" style={s.footerLink}>Discord</a>
        </div>
      </footer>

      {/* ── Cookie consent ───────────────────────────────────────────── */}
      {!cookieDismissed && (
        <div style={s.cookieBanner}>
          <span style={s.cookieText}>
            This site uses a session cookie for authentication. No tracking, no ads, no third-party cookies.
          </span>
          <button onClick={() => setCookieDismissed(true)} style={s.cookieBtn}>OK</button>
        </div>
      )}
    </main>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────

const s: Record<string, React.CSSProperties> = {
  page: {
    minHeight: "100vh",
    background: "var(--color-sky-deep)",
    color: "var(--color-cloud)",
    fontFamily: "var(--font-mono)",
    display: "flex",
    flexDirection: "column",
  },
  // Nav
  nav: {
    display: "flex", justifyContent: "space-between", alignItems: "center",
    padding: "14px 32px", borderBottom: "2px solid rgba(56,189,248,0.12)",
  },
  logo: {
    fontSize: "var(--font-size-lg)", fontWeight: 700, color: "var(--color-accent)",
    textTransform: "uppercase", letterSpacing: "0.05em", textDecoration: "none",
  },
  navLink: {
    color: "var(--color-cloud-dim)", fontSize: "var(--font-size-sm)", textDecoration: "none",
    padding: "6px 16px", border: "1px solid rgba(56,189,248,0.2)", borderRadius: 2,
    transition: "all 0.15s",
  },
  // Hero
  hero: {
    display: "flex", flexDirection: "column", alignItems: "center",
    padding: "48px 32px 32px", maxWidth: 640, margin: "0 auto",
    textAlign: "center", width: "100%",
  },
  title: { fontSize: "clamp(28px, 5vw, 44px)", fontWeight: 800, lineHeight: 1.08, margin: 0, letterSpacing: "-0.02em" },
  subtitle: { fontSize: "var(--font-size-md)", color: "var(--color-cloud-dim)", lineHeight: 1.65, marginTop: 16 },
  // Footer
  footer: {
    display: "flex", justifyContent: "space-between", alignItems: "flex-start",
    padding: "24px 32px 80px", marginTop: "auto", gap: 24, flexWrap: "wrap",
    borderTop: "1px solid rgba(56,189,248,0.08)",
  },
  footerCol: { display: "flex", flexDirection: "column", gap: 4 },
  footerText: {
    fontSize: "var(--font-size-xs)", color: "var(--color-accent)",
    textTransform: "uppercase", letterSpacing: "0.05em", fontWeight: 700,
  },
  footerDim: { fontSize: "var(--font-size-xs)", color: "var(--color-cloud-dim)", opacity: 0.5 },
  footerLinks: { display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" },
  footerLink: { fontSize: "var(--font-size-xs)", color: "var(--color-cloud-dim)", textDecoration: "none", opacity: 0.6 },
  footerDot: { color: "var(--color-cloud-dim)", opacity: 0.25, fontSize: "var(--font-size-xs)" },
  // Cookie
  cookieBanner: {
    position: "fixed", bottom: 0, left: 0, right: 0,
    display: "flex", alignItems: "center", justifyContent: "center",
    gap: 16, padding: "12px 24px", background: "var(--color-sky-mid)",
    borderTop: "1px solid var(--color-sky-high)", zIndex: 100, flexWrap: "wrap",
  },
  cookieText: { fontSize: "var(--font-size-xs)", color: "var(--color-cloud-dim)", lineHeight: 1.5, maxWidth: 600 },
  cookieBtn: {
    padding: "6px 20px", background: "var(--color-accent)", color: "var(--color-sky-deep)",
    border: "none", borderRadius: 2, fontSize: "var(--font-size-xs)", fontWeight: 700,
    cursor: "pointer", fontFamily: "var(--font-mono)", textTransform: "uppercase", letterSpacing: "0.05em", whiteSpace: "nowrap",
  },
};
