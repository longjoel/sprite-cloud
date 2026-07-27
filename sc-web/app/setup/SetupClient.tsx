"use client";

import { useState } from "react";
import { signIn } from "next-auth/react";
import { Box, Button, TextField, Typography, InputAdornment, IconButton } from "@mui/material";
import { Visibility, VisibilityOff } from "@mui/icons-material";

// ── Setup wizard — first-run admin account creation ───────────────────

export default function SetupClient({ initialCode }: { initialCode: string | null }) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [code, setCode] = useState(initialCode ?? "");
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
    <Box sx={s.page}>
      <Box sx={s.card}>
        <Typography variant="h6" align="center" sx={{ fontFamily: "var(--font-mono)", mb: 0.5 }}>
          Sprite Cloud
        </Typography>
        <Typography variant="body2" align="center" color="text.secondary" sx={{ mb: 2.5 }}>
          First-run setup
        </Typography>

        <Box component="form" onSubmit={handleSubmit} sx={{ display: "flex", flexDirection: "column", gap: 2 }}>
          <TextField label="Display name" value={name} onChange={(e) => setName(e.target.value)} required autoComplete="name" fullWidth />
          <TextField type="email" label="Email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="email" fullWidth />
          <TextField
            type={showPassword ? "text" : "password"}
            label="Password (min 4 chars)"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            autoComplete="new-password"
            fullWidth
            slotProps={{
              input: {
                endAdornment: (
                  <InputAdornment position="end">
                    <IconButton onClick={() => setShowPassword(!showPassword)} edge="end" size="small">
                      {showPassword ? <VisibilityOff fontSize="inherit" /> : <Visibility fontSize="inherit" />}
                    </IconButton>
                  </InputAdornment>
                ),
              },
            }}
          />
          <TextField
            label="Setup code (from server logs)"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            required
            autoComplete="off"
            fullWidth
            sx={{ "& input": { fontFamily: "var(--font-mono)", letterSpacing: 2 } }}
          />

          {error && <Typography color="error" variant="body2" align="center">{error}</Typography>}

          <Button type="submit" variant="contained" disabled={loading} fullWidth sx={{ fontFamily: "var(--font-mono)" }}>
            {loading ? "…" : "Create Admin Account"}
          </Button>
        </Box>

        <Typography variant="caption" align="center" color="text.secondary" sx={{ mt: 2, display: "block" }}>
          The setup code is printed in the server console logs on first startup.
        </Typography>
      </Box>
    </Box>
  );
}

const s = {
  page: { minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", p: 2 },
  card: { width: "100%", maxWidth: 360, p: 4, border: "1px solid var(--color-border-default)", borderRadius: "2px" },
};
