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
  const releaseUrl = "https://github.com/longjoel/sprite-cloud/releases/latest";
  const installOneLiner = "curl -fsSL https://sprite-cloud.com/install.sh | bash";

  return (
    <div style={S.wrapper}>
      {/* Step 1: Install */}
      <h3 style={S.step}>1. Install sc-server</h3>
      <p style={S.desc}>
        Run this on your gaming machine:
      </p>
      <pre style={S.preCmd}>{installOneLiner}</pre>
      <p style={S.desc}>
        Or grab the binary from{" "}
        <a href={releaseUrl} target="_blank" rel="noopener" style={S.link}>
          GitHub Releases
        </a>{" "}
        and place it in your PATH.
      </p>

      {/* Step 2: Pair */}
      <h3 style={S.step}>2. Pair with your account</h3>
      <button type="button" style={S.button} onClick={generate} disabled={loading}>
        {loading ? "Generating…" : "Generate Pairing Code"}
      </button>

      {code && (
        <div style={S.codeBlock}>
          <p style={S.desc}>Run this on your gaming machine:</p>
          <pre style={S.preCmd}>{`sc-server pair ${code} --sc-web-url ${origin}`}</pre>
        </div>
      )}

      {error && <p style={S.error}>{error}</p>}

      {/* Step 3: You're done */}
      <h3 style={S.step}>3. You&apos;re done</h3>
      <p style={S.desc}>
        Refresh this page. Your server appears in the list below.
        Place ROMs in the directory you configured and they&apos;ll be scanned automatically.
      </p>
    </div>
  );
}

const S: Record<string, React.CSSProperties> = {
  wrapper: { marginTop: "var(--space-5)" },
  step: {
    color: "var(--color-accent)",
    fontSize: "var(--font-size-base)",
    fontWeight: 600,
    margin: "var(--space-5) 0 var(--space-2)",
    fontFamily: "var(--font-mono)",
  },
  desc: {
    color: "var(--color-cloud-dim)",
    fontSize: "var(--font-size-sm)",
    lineHeight: 1.6,
    margin: 0,
  },
  link: {
    color: "var(--color-accent)",
    textDecoration: "underline",
  },
  inline: {
    background: "var(--color-sky-mid)",
    padding: "1px 4px",
    borderRadius: "2px",
    fontSize: "var(--font-size-xs)",
    fontFamily: "var(--font-mono)",
  },
  pre: {
    margin: "var(--space-2) 0",
    padding: "var(--space-2) var(--space-3)",
    background: "var(--color-sky-deep)",
    border: "1px solid var(--color-sky-high)",
    fontSize: "var(--font-size-xs)",
    fontFamily: "var(--font-mono)",
    color: "var(--color-cloud)",
    overflowX: "auto",
    whiteSpace: "pre-wrap",
    wordBreak: "break-all",
  },
  preCmd: {
    margin: "var(--space-2) 0 0",
    padding: "var(--space-3)",
    background: "var(--color-sky-deep)",
    border: "1px solid var(--color-accent)",
    fontSize: "var(--font-size-sm)",
    fontFamily: "var(--font-mono)",
    color: "var(--color-accent)",
    overflowX: "auto",
    whiteSpace: "pre-wrap",
    wordBreak: "break-all",
  },
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
  },
  error: {
    marginTop: "var(--space-3)",
    color: "var(--color-error)",
    fontSize: "var(--font-size-sm)",
  },
};
