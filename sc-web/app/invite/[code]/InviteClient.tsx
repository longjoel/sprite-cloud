"use client";

import { useEffect, useState } from "react";
import { signIn } from "next-auth/react";
import { Alert, Box, Button, CircularProgress, Paper, Stack, TextField, Typography } from "@mui/material";

interface InviteInfo {
  serverName: string;
  remainingRedemptions: number;
  expiresAt: string | null;
}

function csrfToken(): string {
  const match = document.cookie.match(/(?:^|;\s*)sc_csrf_token=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : "";
}

export default function InviteClient({ code }: { code: string }) {
  const [invite, setInvite] = useState<InviteInfo | null>(null);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let active = true;
    fetch(`/api/invites/${encodeURIComponent(code)}`)
      .then(async (response) => {
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || "Invitation unavailable");
        if (active) setInvite(body.invite);
      })
      .catch((reason) => { if (active) setError(reason instanceof Error ? reason.message : "Invitation unavailable"); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [code]);

  async function redeem(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError("");
    try {
      const response = await fetch(`/api/invites/${encodeURIComponent(code)}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-csrf-token": csrfToken(),
        },
        body: JSON.stringify({ name, email, password }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "Enrollment failed");
      const result = await signIn("credentials", { email, password, redirect: false });
      if (result?.error) throw new Error("Account created, but automatic sign-in failed. Sign in manually.");
      window.location.href = "/";
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Enrollment failed");
      setSaving(false);
    }
  }

  return (
    <Box sx={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", p: 2 }}>
      <Paper variant="outlined" sx={{ width: "100%", maxWidth: 420, p: 4 }}>
        <Typography variant="h5" align="center" color="primary.main">
          Join Sprite Cloud
        </Typography>
        {loading ? (
          <Stack spacing={1.5} sx={{ alignItems: "center", mt: 3 }}>
            <CircularProgress size={24} />
            <Typography color="text.secondary">Checking invitation…</Typography>
          </Stack>
        ) : invite ? (
          <>
            <Typography align="center" color="text.secondary" sx={{ my: 2 }}>
              You were invited to <strong>{invite.serverName || "a Sprite Cloud server"}</strong>.
            </Typography>
            <Box component="form" onSubmit={redeem} sx={{ display: "grid", gap: 2 }}>
              <TextField label="Display name" value={name} onChange={(event) => setName(event.target.value)} required autoComplete="name" />
              <TextField type="email" label="Email" value={email} onChange={(event) => setEmail(event.target.value)} required autoComplete="email" />
              <TextField type="password" label="Password (8+ characters)" value={password} onChange={(event) => setPassword(event.target.value)} required slotProps={{ htmlInput: { minLength: 8, maxLength: 128 } }} autoComplete="new-password" />
              <Button type="submit" variant="contained" disabled={saving}>{saving ? "Creating account…" : "Create account"}</Button>
            </Box>
            <Typography variant="caption" color="text.secondary" sx={{ display: "block", mt: 2, textAlign: "center" }}>
              {invite.remainingRedemptions} redemption{invite.remainingRedemptions === 1 ? "" : "s"} remaining
              {invite.expiresAt ? ` · expires ${new Date(invite.expiresAt).toLocaleString()}` : ""}
            </Typography>
          </>
        ) : null}
        {error && <Alert severity="error" sx={{ mt: 2 }}>{error}</Alert>}
      </Paper>
    </Box>
  );
}
