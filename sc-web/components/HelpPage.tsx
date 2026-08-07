"use client";

import Link from "next/link";
import AppHeader from "@/components/fluent/AppHeader";

// ── Shared constants (mirrored from LandingPage, eventually shared) ──

const CLOUD_ACCENT = "#38bdf8";
const STEP_COLORS = [CLOUD_ACCENT, "#a78bfa", "#34d399"];

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
    title: "Install the server",
    desc: "Run this one-liner on your gaming machine (Linux, Bazzite, Steam Deck, Raspberry Pi):",
    code: "curl -fsSL https://sprite-cloud.com/install.sh | bash",
  },
  {
    num: 2,
    title: "Create an account",
    desc: "Sign in with an email and password. This gives you a personal library, favorites, and access to your game servers.",
    link: { label: "Sign In →", href: "/signin?callbackUrl=/library" },
  },
  {
    num: 3,
    title: "Pair and play",
    desc: "Go to your dashboard, generate a pairing code. Run sc-server pair <code> on your machine to link it to your account. Point it at your ROM directory, open your library, and start streaming.",
  },
];

const FEATURES = [
  { icon: "🎮", title: "Your library", desc: "Browse and search your full retro game collection from any device." },
  { icon: "📺", title: "Browser streaming", desc: "No apps, no plugins. Your games stream directly to any modern browser." },
  { icon: "🔒", title: "Self-hosted", desc: "Your ROMs, your hardware, your rules. No cloud subscription, no monthly fees." },
  { icon: "👥", title: "Multiplayer ready", desc: "Share a link and play together. Multiple players can join your game session." },
  { icon: "📱", title: "Any device", desc: "Desktop, phone, tablet — the responsive player adapts to any screen." },
  { icon: "🎛️", title: "Touch gamepad", desc: "On-screen touch controls for phones and tablets. No controller required." },
];

interface HelpPageProps {
  userName?: string | null;
  authenticated?: boolean;
}

export default function HelpPage({ userName, authenticated = false }: HelpPageProps) {
  return (
    <main style={s.page}>
      <AppHeader
        userName={userName || undefined}
        links={[
          { label: "Home", href: "/" },
          ...(authenticated
            ? [{ label: "Library", href: "/library" }, { label: "Dashboard", href: "/servers" }, { label: "Sign out", href: "/api/auth/signout" }]
            : [{ label: "Sign in", href: "/signin?callbackUrl=/library" }]),
        ]}
      />

      {/* ── Hero ─────────────────────────────────────────────────────── */}
      <section style={s.hero}>
        <h1 style={s.heroTitle}>Setup Guide</h1>
        <p style={s.heroSub}>
          Sprite Cloud streams your games from your own hardware to any browser.
          No subscription, no cloud — just your ROMs, your rules.
        </p>
      </section>

      {/* ── Steps ────────────────────────────────────────────────────── */}
      <section style={s.guide}>
        <h2 style={s.guideH2}>How to set up Sprite Cloud</h2>
        <div style={s.stepsList}>
          {STEPS.map((step) => (
            <div key={step.num} style={s.stepRow}>
              <div style={{ ...s.stepBadge, background: STEP_COLORS[step.num - 1] }}>
                {step.num}
              </div>
              <div style={s.stepContent}>
                <h3 style={s.stepTitle}>{step.title}</h3>
                <p style={s.stepDesc}>{step.desc}</p>
                {step.code && <pre style={s.stepCode}>{step.code}</pre>}
                {step.link && (
                  <Link href={step.link.href} style={s.stepLink}>{step.link.label}</Link>
                )}
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* ── Features ─────────────────────────────────────────────────── */}
      <section style={s.features}>
        <h2 style={s.featuresH2}>What you get</h2>
        <div style={s.featuresGrid}>
          {FEATURES.map((f) => (
            <div key={f.title} style={s.featureCard}>
              <span style={s.featureIcon}>{f.icon}</span>
              <h3 style={s.featureTitle}>{f.title}</h3>
              <p style={s.featureDesc}>{f.desc}</p>
            </div>
          ))}
        </div>
      </section>

      {/* ── Footer ───────────────────────────────────────────────────── */}
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
          <span style={s.footerDot}>·</span>
          <a href="https://discord.gg/zujXa48kyS" target="_blank" rel="noopener noreferrer" style={s.footerLink}>Discord</a>
        </div>
      </footer>
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
  // Hero
  hero: {
    display: "flex", flexDirection: "column", alignItems: "center",
    padding: "80px 32px 60px", maxWidth: 800, margin: "0 auto",
    textAlign: "center",
  },
  heroTitle: {
    fontSize: "clamp(28px, 5vw, 42px)", fontWeight: 800,
    margin: 0, letterSpacing: "-0.02em", color: "var(--color-accent)",
  },
  heroSub: {
    fontSize: "var(--font-size-md)", color: "var(--color-cloud-dim)",
    lineHeight: 1.65, marginTop: 16, maxWidth: 500,
  },
  // Guide
  guide: { maxWidth: 800, margin: "0 auto", padding: "0 32px 80px", width: "100%" },
  guideH2: { fontSize: "var(--font-size-xl)", fontWeight: 700, margin: "0 0 48px", textAlign: "center" },
  stepsList: { display: "flex", flexDirection: "column", gap: 0 },
  stepRow: { display: "flex", gap: 24, padding: "28px 0", borderBottom: "1px solid rgba(56,189,248,0.08)" },
  stepBadge: {
    flex: "0 0 44px", width: 44, height: 44, borderRadius: 2,
    display: "flex", alignItems: "center", justifyContent: "center",
    fontSize: "var(--font-size-lg)", fontWeight: 800, color: "var(--color-sky-deep)",
  },
  stepContent: { flex: 1, minWidth: 0 },
  stepTitle: { fontSize: "var(--font-size-md)", fontWeight: 700, margin: "0 0 6px", color: "var(--color-cloud)" },
  stepDesc: { fontSize: "var(--font-size-sm)", color: "var(--color-cloud-dim)", lineHeight: 1.65, margin: 0 },
  stepCode: {
    marginTop: 12, padding: "10px 14px", background: "rgba(17,24,39,0.6)",
    border: "1px solid var(--color-sky-high)", borderRadius: 2,
    fontSize: "var(--font-size-xs)", color: "var(--color-accent)",
    overflowX: "auto", whiteSpace: "pre-wrap", wordBreak: "break-all",
  },
  stepLink: {
    display: "inline-block", marginTop: 12, padding: "8px 20px",
    background: "var(--color-sky-high)", color: "var(--color-accent)",
    fontSize: "var(--font-size-sm)", fontWeight: 600, textDecoration: "none",
    borderRadius: 2, textTransform: "uppercase", letterSpacing: "0.05em",
  },
  // Features
  features: { maxWidth: 1000, margin: "0 auto", padding: "0 32px 80px", width: "100%" },
  featuresH2: { fontSize: "var(--font-size-xl)", fontWeight: 700, textAlign: "center", margin: "0 0 48px" },
  featuresGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 16 },
  featureCard: {
    padding: 24, border: "1px solid rgba(56,189,248,0.08)", borderRadius: 2,
    background: "rgba(17,24,39,0.4)",
  },
  featureIcon: { fontSize: 28, display: "block", marginBottom: 12 },
  featureTitle: { margin: "0 0 6px", fontSize: "var(--font-size-md)", fontWeight: 700, color: "var(--color-cloud)" },
  featureDesc: { margin: 0, fontSize: "var(--font-size-sm)", color: "var(--color-cloud-dim)", lineHeight: 1.6 },
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
};
