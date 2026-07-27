"use client";

import { useState } from "react";
import { signIn } from "next-auth/react";
import { Box, Button, Tabs, Tab, TextField, Typography, InputAdornment, IconButton } from "@mui/material";
import { Visibility, VisibilityOff } from "@mui/icons-material";

export default function SignInForm() {
  const [tab, setTab] = useState<"signin" | "signup">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleSignIn(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const result = await signIn("credentials", { email, password, redirect: false });
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
    <Box sx={s.page}>
      <Box sx={s.card}>
        <Typography variant="h6" align="center" sx={{ fontFamily: "var(--font-mono)", mb: 3 }}>
          Sprite Cloud
        </Typography>

        <Tabs
          value={tab}
          onChange={(_, v) => { setTab(v); setError(""); }}
          sx={{ mb: 2.5 }}
          variant="fullWidth"
        >
          <Tab value="signin" label="Sign In" />
          <Tab value="signup" label="Sign Up" />
        </Tabs>

        <Box component="form" onSubmit={tab === "signin" ? handleSignIn : handleSignUp} sx={s.form}>
          <TextField
            type="email"
            label="Email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            autoComplete="email"
            fullWidth
          />
          <TextField
            type={showPassword ? "text" : "password"}
            label="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            autoComplete={tab === "signin" ? "current-password" : "new-password"}
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

          {error && <Typography color="error" variant="body2" align="center">{error}</Typography>}

          <Button type="submit" variant="contained" disabled={loading} fullWidth sx={{ fontFamily: "var(--font-mono)", mt: 0.5 }}>
            {loading ? "…" : tab === "signin" ? "Sign In" : "Create Account"}
          </Button>
        </Box>
      </Box>
    </Box>
  );
}

const s = {
  page: { minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", p: 2 },
  card: { width: "100%", maxWidth: 360, p: 4, border: "1px solid var(--color-border-default)", borderRadius: "2px" },
  form: { display: "flex", flexDirection: "column", gap: 2 },
};
