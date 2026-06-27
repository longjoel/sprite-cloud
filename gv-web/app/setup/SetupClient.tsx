"use client";

import { useState } from "react";
import { signIn } from "next-auth/react";

// ── Setup wizard — first-run admin account creation ───────────────────

export default function SetupClient({
  initialCode,
}: {
  initialCode: string | null;
}) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");

    if (password.length < 4) {
      setError("Password must be at least 4 characters");
      return;
    }

    if (!code.trim()) {
      setError("Setup code is required — check docker logs gv-web-gv-web-1");
      return;
    }

    setLoading(true);
    try {
      const res = await fetch("/api/auth/setup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, email, password, code: code.trim() }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Setup failed");
        setLoading(false);
        return;
      }

      // Auto sign in after setup
      await signIn("credentials", { email, password, redirect: false });
      window.location.href = "/";
    } catch {
      setError("Something went wrong");
      setLoading(false);
    }
  }

  return (
    <div style={styles.page}>
      <div style={styles.card}>
        <h1 style={styles.title}>Games Vault</h1>
        <p style={styles.subtitle}>First-run setup</p>

        <form onSubmit={handleSubmit} style={styles.form}>
          <input
            type="text"
            placeholder="Display name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            style={styles.input}
            required
            autoComplete="name"
          />
          <input
            type="email"
            placeholder="you@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            style={styles.input}
            required
            autoComplete="email"
          />
          <input
            type="password"
            placeholder="Password (min 4 chars)"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            style={styles.input}
            required
            minLength={4}
            autoComplete="new-password"
          />
          <input
            type="text"
            placeholder="Setup code (from server logs)"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            style={{
              ...styles.input,
              fontFamily: "'Geist Mono', monospace",
              letterSpacing: "2px",
            }}
            required
            autoComplete="off"
          />

          {error && <p style={styles.error}>{error}</p>}

          <button type="submit" style={styles.button} disabled={loading}>
            {loading ? "…" : "Create Admin Account"}
          </button>
        </form>

        <p style={styles.hint}>
          The setup code is printed in the server logs.
          <br />
          Run: <code style={styles.code}>docker logs gv-web-gv-web-1</code>
        </p>
      </div>
    </div>
  );
}

// ── Inline styles (Humidor palette) ───────────────────────────────────

const styles: Record<string, React.CSSProperties> = {
  page: {
    minHeight: "100vh",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    background: "#1a1410",
    padding: "16px",
  },
  card: {
    width: "100%",
    maxWidth: "360px",
    background: "#2d2418",
    border: "1px solid #b8964a",
    borderRadius: "4px",
    padding: "32px 24px",
  },
  title: {
    color: "#e8dcc8",
    fontSize: "20px",
    fontWeight: 700,
    textAlign: "center",
    marginBottom: "4px",
    fontFamily: "'Geist Mono', monospace",
  },
  subtitle: {
    color: "#b8a888",
    fontSize: "13px",
    textAlign: "center",
    marginBottom: "20px",
    fontFamily: "'Geist', sans-serif",
  },
  form: {
    display: "flex",
    flexDirection: "column",
    gap: "12px",
  },
  input: {
    padding: "10px 12px",
    background: "#1a1410",
    border: "1px solid #4a3a28",
    borderRadius: "4px",
    color: "#e8dcc8",
    fontSize: "13px",
    fontFamily: "'Geist', sans-serif",
    outline: "none",
  },
  button: {
    padding: "10px 0",
    background: "#b8964a",
    color: "#1a1410",
    border: "none",
    borderRadius: "4px",
    fontSize: "14px",
    fontWeight: 600,
    cursor: "pointer",
    fontFamily: "'Geist', sans-serif",
    marginTop: "4px",
  },
  error: {
    color: "#ff4d4d",
    fontSize: "12px",
    textAlign: "center",
  },
  hint: {
    color: "#6b6040",
    fontSize: "11px",
    textAlign: "center",
    marginTop: "16px",
    fontFamily: "'Geist', sans-serif",
    lineHeight: "1.6",
  },
  code: {
    background: "#1a1410",
    padding: "1px 6px",
    borderRadius: "2px",
    fontFamily: "'Geist Mono', monospace",
    fontSize: "11px",
    color: "#b8964a",
  },
};
