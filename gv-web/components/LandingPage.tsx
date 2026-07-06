"use client";

import { useState } from "react";
import Link from "next/link";

// ── LandingPage — public hero + setup guide for unauthenticated visitors

const CLOUD_ACCENT = "#38bdf8"; // sky-blue
const STEP_COLORS = [CLOUD_ACCENT, "#a78bfa", "#34d399", "#fbbf24"];

interface Step {
  num: number;
  title: string;
  desc: string;
  code?: string;
  link?: { label: string; href: string };
}

const STEPS: Step[] = [
  {
    num: 1,
    title: "Make an account",
    desc: "Sign up with an email and password. This gives you a personal library, favorites, pins, and access to your game servers.",
    link: { label: "Sign Up →", href: "/signin" },
  },
  {
    num: 2,
    title: "Install the server",
    desc: "Download the gv-server binary for your platform (Linux, Bazzite, Steam Deck). Run the pairing command shown on the setup page to link it to your account.",
    code: "GV_ROM_ROOTS=/path/to/roms  GV_CORES_DIR=/path/to/cores  ./gv-server start",
  },
  {
    num: 3,
    title: "Gather your games",
    desc: "Point gv-server at your ROM directories. Supported platforms include NES, SNES, Genesis, Game Boy, PlayStation, arcade, and many more — anything with a libretro core.",
  },
  {
    num: 4,
    title: "Play!",
    desc: "Open your library in any browser. Click a game to start streaming — touch controls work on phones and tablets. Share a link and friends can watch or join.",
  },
];

export default function LandingPage() {
  const [cookieDismissed, setCookieDismissed] = useState(false);

  const scrollToGuide = (e: React.MouseEvent) => {
    e.preventDefault();
    document.getElementById("guide")?.scrollIntoView({ behavior: "smooth" });
  };

  return (
    <main style={s.page}>
      {/* ── Nav bar ─────────────────────────────────────────────────── */}
      <nav style={s.nav}>
        <span style={s.logo}>Sprite Cloud</span>
        <Link href="/signin" style={s.navLink}>
          Sign In →
        </Link>
      </nav>

      {/* ── Hero ────────────────────────────────────────────────────── */}
      <section style={s.hero}>
        <div style={s.heroInner}>
          <h1 style={s.title}>
            Your games.
            <br />
            <span style={{ color: CLOUD_ACCENT }}>Any screen.</span>
          </h1>
          <p style={s.subtitle}>
            Stream your retro game library from your own hardware to any
            device — browser, phone, or tablet. No cloud subscription, no
            monthly fees. Just your ROMs, your server, your games.
          </p>
          <div style={s.ctaRow}>
            <a href="#guide" onClick={scrollToGuide} style={s.ctaPrimary}>
              Get Started
            </a>
            <Link href="/signin" style={s.ctaSecondary}>
              Sign In
            </Link>
          </div>
          <div style={{ marginTop: "24px", padding: "14px 18px", background: "rgba(56,189,248,0.06)", border: "1px solid rgba(56,189,248,0.15)", borderRadius: 2, maxWidth: 340 }}>
            <p style={{ fontSize: "var(--font-size-xs)", color: "var(--color-cloud-dim)", margin: 0 }}>
              Try the demo: <span style={{ color: "var(--color-accent)", fontWeight: 600 }}>test123@lngnckr.tech</span>
              &nbsp;/&nbsp;
              <span style={{ color: "var(--color-accent)", fontWeight: 600 }}>test123</span>
            </p>
          </div>
        </div>
        <div style={s.heroVisual}>
          <div style={s.visualStack}>
            {[
              "#bf2a36","#5a3d8a","#1e3660","#1e3460","#6b8e1e",
              "#c46a1a","#6a2c8a","#2d6b2d","#c64a1e",
            ].map((c, i) => (
              <div
                key={i}
                style={{
                  width: `${120 - i * 8}px`,
                  height: "12px",
                  background: c,
                  borderRadius: 2,
                  opacity: 0.85 - i * 0.06,
                  transform: `translateX(${i % 2 === 0 ? "-" : ""}${i * 3}px) rotate(${i % 2 === 0 ? "-" : ""}${i * 0.8}deg)`,
                }}
              />
            ))}
          </div>
        </div>
      </section>

      {/* ── Setup Guide ─────────────────────────────────────────────── */}
      <section id="guide" style={s.guide}>
        <h2 style={s.guideH2}>How to set up Sprite Cloud</h2>
        <div style={s.stepsList}>
          {STEPS.map((step) => (
            <div key={step.num} style={s.stepRow}>
              {/* Step number badge */}
              <div
                style={{
                  ...s.stepBadge,
                  background: STEP_COLORS[step.num - 1],
                }}
              >
                {step.num}
              </div>
              {/* Step content */}
              <div style={s.stepContent}>
                <h3 style={s.stepTitle}>{step.title}</h3>
                <p style={s.stepDesc}>{step.desc}</p>
                {step.code && (
                  <pre style={s.stepCode}>{step.code}</pre>
                )}
                {step.link && (
                  <Link href={step.link.href} style={s.stepLink}>
                    {step.link.label}
                  </Link>
                )}
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* ── Bottom CTA ──────────────────────────────────────────────── */}
      <section style={s.bottomCta}>
        <h2 style={s.bottomTitle}>Ready to start?</h2>
        <p style={s.bottomSub}>
          Step 1 takes 10 seconds. Already have an account?
        </p>
        <div style={{ display: "flex", gap: 14, justifyContent: "center" }}>
          <Link href="/signin" style={s.ctaPrimary}>
            Create Account
          </Link>
          <Link href="/signin" style={s.ctaSecondary}>
            Sign In
          </Link>
        </div>
      </section>

      {/* ── Footer ──────────────────────────────────────────────────── */}
      <footer style={s.footer}>
        <div style={s.footerCol}>
          <span style={s.footerText}>Sprite Cloud</span>
          <span style={s.footerDim}>self-hosted game streaming</span>
        </div>
        <div style={s.footerLinks}>
          <span style={s.footerDim}>© {new Date().getFullYear()} Sprite Cloud</span>
          <span style={s.footerDot}>·</span>
          <a href="https://github.com/longjoel/sprite-cloud/blob/main/LICENSE" target="_blank" rel="noopener noreferrer" style={s.footerLink}>License</a>
          <span style={s.footerDot}>·</span>
          <a href="https://github.com/longjoel/sprite-cloud" target="_blank" rel="noopener noreferrer" style={s.footerLink}>Source</a>
        </div>
      </footer>

      {/* ── Cookie consent banner ──────────────────────────────────── */}
      {!cookieDismissed && (
        <div style={s.cookieBanner}>
          <span style={s.cookieText}>
            This site uses a session cookie for authentication. No tracking, no ads, no third-party cookies.
          </span>
          <button onClick={() => setCookieDismissed(true)} style={s.cookieBtn}>
            OK
          </button>
        </div>
      )}
    </main>
  );
}

// ── Styles ────────────────────────────────────────────────────────────

const s: Record<string, React.CSSProperties> = {
  page: {
    minHeight: "100vh",
    background: "var(--color-sky-deep)",
    color: "var(--color-cloud)",
    fontFamily: "var(--font-mono)",
    display: "flex",
    flexDirection: "column",
    scrollBehavior: "smooth",
  },

  // Nav
  nav: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: "14px 32px",
    borderBottom: "2px solid rgba(56,189,248,0.12)",
  },
  logo: {
    fontSize: "var(--font-size-lg)",
    fontWeight: 700,
    color: "var(--color-accent)",
    textTransform: "uppercase",
    letterSpacing: "0.05em",
  },
  navLink: {
    color: "var(--color-cloud-dim)",
    fontSize: "var(--font-size-sm)",
    textDecoration: "none",
    padding: "6px 16px",
    border: "1px solid rgba(56,189,248,0.2)",
    borderRadius: 2,
    transition: "all 0.15s",
  },

  // Hero
  hero: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: "64px",
    padding: "80px 32px",
    maxWidth: "1100px",
    margin: "0 auto",
    width: "100%",
    flexWrap: "wrap" as const,
  },
  heroInner: {
    flex: "1 1 400px",
    maxWidth: "540px",
  },
  title: {
    fontSize: "clamp(36px, 6vw, 56px)",
    fontWeight: 800,
    lineHeight: 1.08,
    margin: 0,
    letterSpacing: "-0.02em",
  },
  subtitle: {
    fontSize: "var(--font-size-md)",
    color: "var(--color-cloud-dim)",
    lineHeight: 1.65,
    marginTop: "24px",
    maxWidth: "460px",
  },
  ctaRow: {
    display: "flex",
    gap: "14px",
    marginTop: "36px",
  },
  ctaPrimary: {
    padding: "12px 32px",
    background: "var(--color-accent)",
    color: "var(--color-sky-deep)",
    fontSize: "var(--font-size-md)",
    fontWeight: 700,
    border: "none",
    borderRadius: 2,
    cursor: "pointer",
    textDecoration: "none",
    textTransform: "uppercase" as const,
    letterSpacing: "0.05em",
    fontFamily: "var(--font-mono)",
  },
  ctaSecondary: {
    padding: "12px 32px",
    background: "transparent",
    color: "var(--color-accent)",
    fontSize: "var(--font-size-md)",
    fontWeight: 600,
    border: "1px solid rgba(56,189,248,0.3)",
    borderRadius: 2,
    cursor: "pointer",
    textDecoration: "none",
    fontFamily: "var(--font-mono)",
  },

  // Hero visual
  heroVisual: {
    flex: "0 0 260px",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  },
  visualStack: {
    display: "flex",
    flexDirection: "column",
    gap: "6px",
    padding: "40px 20px",
    background: "rgba(17,24,39,0.6)",
    border: "1px solid rgba(56,189,248,0.1)",
    borderRadius: 4,
  },

  // Guide
  guide: {
    maxWidth: "800px",
    margin: "0 auto",
    padding: "80px 32px",
    width: "100%",
  },
  guideH2: {
    fontSize: "var(--font-size-xl)",
    fontWeight: 700,
    margin: "0 0 48px",
    color: "var(--color-cloud)",
    textAlign: "center" as const,
  },
  stepsList: {
    display: "flex",
    flexDirection: "column",
    gap: "0",
  },
  stepRow: {
    display: "flex",
    gap: "24px",
    padding: "28px 0",
    borderBottom: "1px solid rgba(56,189,248,0.08)",
  },
  stepBadge: {
    flex: "0 0 44px",
    width: "44px",
    height: "44px",
    borderRadius: 2,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontSize: "var(--font-size-lg)",
    fontWeight: 800,
    color: "var(--color-sky-deep)",
    fontFamily: "var(--font-mono)",
  },
  stepContent: {
    flex: 1,
    minWidth: 0,
  },
  stepTitle: {
    fontSize: "var(--font-size-md)",
    fontWeight: 700,
    margin: "0 0 6px",
    color: "var(--color-cloud)",
  },
  stepDesc: {
    fontSize: "var(--font-size-sm)",
    color: "var(--color-cloud-dim)",
    lineHeight: 1.65,
    margin: 0,
  },
  stepCode: {
    marginTop: "12px",
    padding: "10px 14px",
    background: "rgba(17,24,39,0.6)",
    border: "1px solid var(--color-sky-high)",
    borderRadius: 2,
    fontSize: "var(--font-size-xs)",
    color: "var(--color-accent)",
    overflowX: "auto" as const,
    whiteSpace: "pre-wrap" as const,
    wordBreak: "break-all" as const,
    fontFamily: "var(--font-mono)",
  },
  stepLink: {
    display: "inline-block",
    marginTop: "12px",
    padding: "8px 20px",
    background: "var(--color-sky-high)",
    color: "var(--color-accent)",
    fontSize: "var(--font-size-sm)",
    fontWeight: 600,
    textDecoration: "none",
    borderRadius: 2,
    fontFamily: "var(--font-mono)",
    textTransform: "uppercase" as const,
    letterSpacing: "0.05em",
  },

  // Bottom CTA
  bottomCta: {
    textAlign: "center" as const,
    padding: "80px 32px",
    borderTop: "1px solid rgba(56,189,248,0.08)",
    borderBottom: "1px solid rgba(56,189,248,0.08)",
    background: "rgba(17,24,39,0.4)",
  },
  bottomTitle: {
    fontSize: "var(--font-size-xl)",
    fontWeight: 700,
    margin: 0,
    color: "var(--color-cloud)",
  },
  bottomSub: {
    fontSize: "var(--font-size-md)",
    color: "var(--color-cloud-dim)",
    marginTop: "8px",
  },

  // Footer
  footer: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "flex-start",
    padding: "24px 32px 80px",
    marginTop: "auto",
    gap: "24px",
    flexWrap: "wrap" as const,
  },
  footerCol: {
    display: "flex",
    flexDirection: "column",
    gap: "4px",
  },
  footerText: {
    fontSize: "var(--font-size-xs)",
    color: "var(--color-accent)",
    textTransform: "uppercase" as const,
    letterSpacing: "0.05em",
    fontWeight: 700,
  },
  footerDim: {
    fontSize: "var(--font-size-xs)",
    color: "var(--color-cloud-dim)",
    opacity: 0.5,
  },
  footerLinks: {
    display: "flex",
    alignItems: "center",
    gap: "10px",
    flexWrap: "wrap" as const,
  },
  footerDot: {
    color: "var(--color-cloud-dim)",
    opacity: 0.25,
    fontSize: "var(--font-size-xs)",
  },
  footerLink: {
    fontSize: "var(--font-size-xs)",
    color: "var(--color-cloud-dim)",
    textDecoration: "none",
    opacity: 0.6,
    transition: "opacity 0.15s",
  },

  // Cookie consent banner
  cookieBanner: {
    position: "fixed",
    bottom: 0,
    left: 0,
    right: 0,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: "16px",
    padding: "12px 24px",
    background: "var(--color-sky-mid)",
    borderTop: "1px solid var(--color-sky-high)",
    zIndex: 100,
    fontFamily: "var(--font-mono)",
    flexWrap: "wrap" as const,
  },
  cookieText: {
    fontSize: "var(--font-size-xs)",
    color: "var(--color-cloud-dim)",
    lineHeight: 1.5,
    maxWidth: "600px",
  },
  cookieBtn: {
    padding: "6px 20px",
    background: "var(--color-accent)",
    color: "var(--color-sky-deep)",
    border: "none",
    borderRadius: 2,
    fontSize: "var(--font-size-xs)",
    fontWeight: 700,
    cursor: "pointer",
    fontFamily: "var(--font-mono)",
    textTransform: "uppercase" as const,
    letterSpacing: "0.05em",
    whiteSpace: "nowrap" as const,
  },
};
