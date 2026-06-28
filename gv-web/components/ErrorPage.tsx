"use client";

import Link from "next/link";

interface ErrorPageProps {
  code: number;
  title: string;
  message: string;
  action?: { label: string; href: string };
}

export function ErrorPage({ code, title, message, action }: ErrorPageProps) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        minHeight: "100vh",
        padding: "2rem",
        background: "var(--color-mahogany, #1a1410)",
        color: "var(--color-cream, #e8dcc8)",
        fontFamily: "var(--font-mono, monospace)",
        textAlign: "center",
        gap: "var(--space-3, 6px)",
      }}
    >
      <div
        style={{
          fontSize: "clamp(4rem, 15vw, 8rem)",
          fontWeight: 700,
          color: "var(--color-brass, #b8964a)",
          lineHeight: 1,
          marginBottom: "0.25em",
        }}
      >
        {code}
      </div>

      <div
        style={{
          fontSize: "var(--font-size-md, 14px)",
          color: "var(--color-cream, #e8dcc8)",
          letterSpacing: "0.08em",
          textTransform: "uppercase",
          marginBottom: "0.5em",
        }}
      >
        {title}
      </div>

      <div
        style={{
          fontSize: "var(--font-size-sm, 12px)",
          color: "var(--color-muted, #b8a888)",
          maxWidth: 360,
          lineHeight: 1.6,
          marginBottom: "2em",
        }}
      >
        {message}
      </div>

      {action && (
        <Link
          href={action.href}
          style={{
            display: "inline-block",
            padding: "var(--space-3, 6px) var(--space-7, 24px)",
            border: "1px solid var(--color-brass, #b8964a)",
            color: "var(--color-brass, #b8964a)",
            fontSize: "var(--font-size-sm, 12px)",
            fontFamily: "var(--font-mono, monospace)",
            textDecoration: "none",
            textTransform: "uppercase",
            letterSpacing: "0.1em",
            transition: "0.15s",
          }}
        >
          {action.label}
        </Link>
      )}

      {!action && (
        <Link
          href="/"
          style={{
            display: "inline-block",
            padding: "var(--space-3, 6px) var(--space-7, 24px)",
            border: "1px solid var(--color-bamboo, #4a3a28)",
            color: "var(--color-muted, #b8a888)",
            fontSize: "var(--font-size-sm, 12px)",
            fontFamily: "var(--font-mono, monospace)",
            textDecoration: "none",
            textTransform: "uppercase",
            letterSpacing: "0.1em",
          }}
        >
          Go home
        </Link>
      )}
    </div>
  );
}
