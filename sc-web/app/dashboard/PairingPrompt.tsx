"use client";

import { useState } from "react";
import { csrfHeaders } from "./dashboard-utils";

export default function PairingPrompt() {
  const [code, setCode] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function generate() {
    setLoading(true);
    setCode(null);
    setError(null);
    try {
      const res = await fetch("/api/auth/pair/generate", { method: "POST", headers: csrfHeaders() });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      setCode(body.code);
    } catch (e: any) {
      setError(e.message || "Pairing failed");
    } finally {
      setLoading(false);
    }
  }

  const origin = typeof window !== "undefined" ? window.location.origin : "";

  return (
    <div style={S.wrapper}>
      <button type="button" style={S.button} onClick={generate} disabled={loading}>
        {loading ? "Generating…" : "Generate Pairing Code"}
      </button>

      {code && (
        <div style={S.codeBlock}>
          <span style={S.label}>Pairing code</span>
          <code style={S.code}>{code}</code>
          <code style={S.command}>
            sc-server pair {code} --sc-web-url {origin}
          </code>
        </div>
      )}

      {error && <p style={S.error}>{error}</p>}
    </div>
  );
}

const S: Record<string, React.CSSProperties> = {
  wrapper: { marginTop: "var(--space-5)" },
  button: {
    padding: "10px 20px",
    background: "var(--color-accent)",
    color: "var(--color-sky-deep)",
    border: "none",
    borderRadius: "2px",
    fontSize: "14px",
    fontWeight: 600,
    cursor: "pointer",
    fontFamily: "var(--font-mono)",
  },
  codeBlock: {
    marginTop: "var(--space-4)",
    padding: "var(--space-4)",
    border: "1px solid var(--color-accent)",
    background: "rgba(56,189,248,0.06)",
  },
  label: {
    display: "block",
    color: "var(--color-cloud-dim)",
    fontSize: "var(--font-size-xs)",
    textTransform: "uppercase",
    marginBottom: "var(--space-2)",
    fontFamily: "var(--font-mono)",
  },
  code: {
    display: "block",
    fontSize: "var(--font-size-lg)",
    fontWeight: 700,
    color: "var(--color-accent)",
    padding: "var(--space-2) 0",
    fontFamily: "var(--font-mono)",
  },
  command: {
    display: "block",
    marginTop: "var(--space-3)",
    padding: "var(--space-3)",
    fontSize: "var(--font-size-sm)",
    color: "var(--color-cloud)",
    background: "var(--color-sky-mid)",
    fontFamily: "var(--font-mono)",
    overflowX: "auto",
    whiteSpace: "pre-wrap",
    wordBreak: "break-all",
  },
  error: {
    marginTop: "var(--space-3)",
    color: "var(--color-error)",
    fontSize: "var(--font-size-sm)",
  },
};
