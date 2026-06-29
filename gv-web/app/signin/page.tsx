"use client";

import { useState } from "react";
import { signIn } from "next-auth/react";

// ── Sign-in / Sign-up page — tabbed form ──────────────────────────────

export default function SignInPage() {
  const [tab, setTab] = useState<"signin" | "signup">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleSignIn(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const result = await signIn("credentials", {
        email,
        password,
        redirect: false,
      });
      if (result?.error) {
        setError("Invalid email or password");
      } else {
        window.location.href = "/";
      }
    } catch {
      setError("Something went wrong");
    } finally {
      setLoading(false);
    }
  }

  async function handleSignUp(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    if (password.length < 4) {
      setError("Password must be at least 4 characters");
      return;
    }
    setLoading(true);
    try {
      const res = await fetch("/api/auth/signup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Sign-up failed");
      } else {
        // Auto sign in after sign-up
        await signIn("credentials", { email, password, redirect: false });
        window.location.href = "/";
      }
    } catch {
      setError("Something went wrong");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={styles.page}>
      <div style={styles.card}>
        <h1 style={styles.title}>Sprite Cloud</h1>

        {/* Tabs */}
        <div style={styles.tabs}>
          <button
            onClick={() => { setTab("signin"); setError(""); }}
            style={{
              ...styles.tab,
              ...(tab === "signin" ? styles.tabActive : {}),
            }}
          >
            Sign In
          </button>
          <button
            onClick={() => { setTab("signup"); setError(""); }}
            style={{
              ...styles.tab,
              ...(tab === "signup" ? styles.tabActive : {}),
            }}
          >
            Sign Up
          </button>
        </div>

        <form
          onSubmit={tab === "signin" ? handleSignIn : handleSignUp}
          style={styles.form}
        >
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
            placeholder="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            style={styles.input}
            required
            minLength={4}
            autoComplete={tab === "signin" ? "current-password" : "new-password"}
          />

          {error && <p style={styles.error}>{error}</p>}

          <button type="submit" style={styles.button} disabled={loading}>
            {loading ? "…" : tab === "signin" ? "Sign In" : "Create Account"}
          </button>
        </form>
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
    background: "#1a1410", // mahogany
    padding: "16px",
  },
  card: {
    width: "100%",
    maxWidth: "360px",
    background: "#2d2418", // teak
    border: "1px solid #b8964a", // brass
    borderRadius: "4px",
    padding: "32px 24px",
  },
  title: {
    color: "#e8dcc8", // cream
    fontSize: "20px",
    fontWeight: 700,
    textAlign: "center",
    marginBottom: "24px",
    fontFamily: "'Geist Mono', monospace",
  },
  tabs: {
    display: "flex",
    gap: "0",
    marginBottom: "20px",
    borderBottom: "1px solid #b8964a",
  },
  tab: {
    flex: 1,
    padding: "8px 0",
    background: "none",
    border: "none",
    color: "#b8a888",
    fontSize: "13px",
    fontWeight: 600,
    cursor: "pointer",
    borderBottom: "2px solid transparent",
    fontFamily: "'Geist', sans-serif",
  },
  tabActive: {
    color: "#e8dcc8",
    borderBottomColor: "#b8964a",
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
};
