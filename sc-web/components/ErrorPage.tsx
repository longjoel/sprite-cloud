"use client";

import Link from "next/link";
import { useId } from "react";

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

/** Generate a short diagnostic ID from the error context. */
function diagnosticId(code: number): string {
  const ts = Date.now().toString(36).slice(-4);
  return `ERR-${code}-${ts}`;
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
  const diagId = diagnosticId(code);

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
          maxWidth: 420,
          lineHeight: 1.6,
          marginBottom: "1.5em",
        }}
      >
        {message}
      </div>

      {/* Diagnostic ID — for support, not user-facing */}
      <div
        style={{
          fontSize: "10px",
          color: "var(--color-cloud-dim)",
          opacity: 0.4,
          marginBottom: "2em",
          fontFamily: "var(--font-mono)",
        }}
      >
        {diagId}
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
