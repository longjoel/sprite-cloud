"use client";

import Link from "next/link";

// ── AppHeader — shared top bar for all authenticated pages ─────────
//
// Metro-style: clean, flat, with the sky-blue accent line at bottom.

interface AppHeaderProps {
  userName?: string | null;
  links?: { label: string; href: string }[];
}

export default function AppHeader({
  userName,
  links = [],
}: AppHeaderProps) {
  return (
    <header
      style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        padding: "12px 24px",
        borderBottom: "2px solid var(--color-accent)",
        background: "var(--color-sky-mid)",
        position: "sticky",
        top: 0,
        zIndex: 50,
      }}
    >
      {/* Title */}
      <Link
        href="/"
        style={{
          fontSize: "var(--font-size-lg)",
          fontWeight: 700,
          color: "var(--color-accent)",
          textDecoration: "none",
          fontFamily: "var(--font-mono)",
          letterSpacing: "0.02em",
          textTransform: "uppercase",
        }}
      >
        Sprite Cloud
      </Link>

      {/* Right side */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "var(--space-6)",
          fontSize: "var(--font-size-sm)",
        }}
      >
        {userName && (
          <span style={{ color: "var(--color-cloud-dim)" }}>
            {userName}
          </span>
        )}
        {links.map((link) => (
          <Link
            key={link.href}
            href={link.href}
            style={{
              color: "var(--color-accent)",
              textDecoration: "none",
              fontFamily: "var(--font-mono)",
              fontSize: "var(--font-size-sm)",
            }}
          >
            {link.label}
          </Link>
        ))}
      </div>
    </header>
  );
}
