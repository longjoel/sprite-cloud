"use client";

import Link from "next/link";

interface ErrorPageAction {
  label: string;
  href?: string;
  onClick?: () => void;
}

interface ErrorPageProps {
  code: number;
  title: string;
  message: string;
  action?: ErrorPageAction;
}

const actionStyle: React.CSSProperties = {
  display: "inline-block",
  padding: "var(--space-3, 6px) var(--space-7, 24px)",
  border: "1px solid var(--color-accent)",
  color: "var(--color-accent)",
  background: "transparent",
  fontSize: "var(--font-size-sm, 12px)",
  fontFamily: "var(--font-mono, monospace)",
  textDecoration: "none",
  textTransform: "uppercase",
  letterSpacing: "0.1em",
  transition: "0.15s",
  cursor: "pointer",
};

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
        background: "var(--color-sky-deep)",
        color: "var(--color-text-primary)",
        fontFamily: "var(--font-mono, monospace)",
        textAlign: "center",
        gap: "var(--space-3, 6px)",
      }}
    >
      <div
        style={{
          fontSize: "clamp(4rem, 15vw, 8rem)",
          fontWeight: 700,
          color: "var(--color-accent)",
          lineHeight: 1,
          marginBottom: "0.25em",
        }}
      >
        {code}
      </div>

      <div
        style={{
          fontSize: "var(--font-size-md, 14px)",
          color: "var(--color-text-primary)",
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
          color: "var(--color-text-secondary)",
          maxWidth: 360,
          lineHeight: 1.6,
          marginBottom: "2em",
        }}
      >
        {message}
      </div>

      {action?.onClick ? (
        <button type="button" onClick={action.onClick} style={actionStyle}>
          {action.label}
        </button>
      ) : action?.href ? (
        <Link href={action.href} style={actionStyle}>
          {action.label}
        </Link>
      ) : (
        <Link
          href="/"
          style={{
            ...actionStyle,
            border: "1px solid var(--color-border-default)",
            color: "var(--color-text-secondary)",
          }}
        >
          Go home
        </Link>
      )}
    </div>
  );
}
