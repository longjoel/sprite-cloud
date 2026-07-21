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
      setError("Setup code is required — it was printed to the server console on startup");
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
        <h1 style={styles.title}>Sprite Cloud</h1>
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
              fontFamily: "var(--font-mono)",
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
          The setup code is printed in the server console logs on first startup.
        </p>
      </div>
    </div>
  );
}

// ── Metro styles (dark cloud palette) ─────────────────────────────────

const styles: Record<string, React.CSSProperties> = {
  page: {
    minHeight: "100vh",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    background: "var(--color-sky-deep)",
    padding: "16px",
  },
  card: {
    width: "100%",
    maxWidth: "360px",
    background: "var(--color-surface-default)",
    border: "1px solid var(--color-border-default)",
    borderRadius: "2px",
    padding: "32px 24px",
  },
  title: {
    color: "var(--color-text-primary)",
    fontSize: "20px",
    fontWeight: 700,
    textAlign: "center",
    marginBottom: "4px",
    fontFamily: "var(--font-mono)",
  },
  subtitle: {
    color: "var(--color-text-secondary)",
    fontSize: "13px",
    textAlign: "center",
    marginBottom: "20px",
    fontFamily: "var(--font-sans)",
  },
  form: {
    display: "flex",
    flexDirection: "column",
    gap: "12px",
  },
  input: {
    padding: "10px 12px",
    background: "var(--color-bg-deep)",
    border: "1px solid var(--color-border-default)",
    borderRadius: "2px",
    color: "var(--color-text-primary)",
    fontSize: "13px",
    fontFamily: "var(--font-sans)",
    outline: "none",
  },
  button: {
    padding: "10px 0",
    background: "var(--color-accent)",
    color: "var(--color-sky-deep)",
    border: "none",
    borderRadius: "2px",
    fontSize: "14px",
    fontWeight: 600,
    cursor: "pointer",
    fontFamily: "var(--font-sans)",
    marginTop: "4px",
  },
  error: {
    color: "var(--color-error)",
    fontSize: "12px",
    textAlign: "center",
  },
  hint: {
    color: "var(--color-text-secondary)",
    fontSize: "11px",
    textAlign: "center",
    marginTop: "16px",
    fontFamily: "var(--font-sans)",
    lineHeight: "1.6",
    opacity: 0.6,
  },
};
