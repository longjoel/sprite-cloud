"use client";

import { useCallback, useEffect, useState } from "react";
import { Box, Button, MenuItem, TextField, Typography } from "@mui/material";
import { csrfHeaders } from "./dashboard-utils";

interface Redemption {
  userId: string;
  email: string;
  name: string | null;
  redeemedAt: string;
}

interface InviteSummary {
  id: string;
  codePrefix: string;
  maxRedemptions: number;
  redemptionCount: number;
  expiresAt: string | null;
  revokedAt: string | null;
  createdAt: string;
  redemptions: Redemption[];
}

export default function InviteManager({ serverId, canManage }: { serverId: string; canManage: boolean }) {
  const [invites, setInvites] = useState<InviteSummary[]>([]);
  const [maxRedemptions, setMaxRedemptions] = useState(1);
  const [expiresInHours, setExpiresInHours] = useState<number | "">(24);
  const [generatedUrl, setGeneratedUrl] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    if (!canManage) {
      setInvites([]);
      setLoading(false);
      return;
    }
    try {
      const response = await fetch(`/api/servers/${serverId}/invites`);
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "Failed to load invitations");
      setInvites(body.invites ?? []);
      setError("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Failed to load invitations");
    } finally {
      setLoading(false);
    }
  }, [canManage, serverId]);

  useEffect(() => { void load(); }, [load]);

  async function createInvite(event: React.FormEvent) {
    event.preventDefault();
    if (!canManage) return;
    setSaving(true);
    setError("");
    try {
      const response = await fetch(`/api/servers/${serverId}/invites`, {
        method: "POST",
        headers: csrfHeaders(),
        body: JSON.stringify({
          maxRedemptions,
          expiresInHours: expiresInHours === "" ? null : expiresInHours,
        }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "Failed to create invitation");
      setGeneratedUrl(`${window.location.origin}${body.invite.url}`);
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Failed to create invitation");
    } finally {
      setSaving(false);
    }
  }

  async function revokeInvite(inviteId: string) {
    setError("");
    try {
      const response = await fetch(`/api/servers/${serverId}/invites/${inviteId}`, {
        method: "DELETE",
        headers: csrfHeaders(),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "Failed to revoke invitation");
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Failed to revoke invitation");
    }
  }

  return (
    <Box sx={{ mt: 4, pt: 3, borderTop: "1px solid var(--color-sky-high)" }}>
      <Typography variant="h6" sx={{ fontFamily: "var(--font-mono)", color: "var(--color-accent)" }}>
        Enrollment invitations
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        {canManage
          ? "Create a private account-enrollment link. The new account joins this server as a member."
          : "Only server administrators can create and review enrollment invitations."}
      </Typography>

      <Box component="form" onSubmit={createInvite} sx={{ display: "flex", gap: 2, flexWrap: "wrap", alignItems: "center" }}>
        <TextField
          select
          size="small"
          disabled={!canManage}
          label="Uses"
          value={maxRedemptions}
          onChange={(event) => setMaxRedemptions(Number(event.target.value))}
          sx={{ minWidth: 150 }}
        >
          <MenuItem value={1}>One-time</MenuItem>
          <MenuItem value={5}>5 uses</MenuItem>
          <MenuItem value={10}>10 uses</MenuItem>
          <MenuItem value={25}>25 uses</MenuItem>
        </TextField>
        <TextField
          select
          size="small"
          disabled={!canManage}
          label="Expires"
          value={expiresInHours}
          onChange={(event) => setExpiresInHours(event.target.value === "" ? "" : Number(event.target.value))}
          sx={{ minWidth: 150 }}
        >
          <MenuItem value={1}>1 hour</MenuItem>
          <MenuItem value={24}>24 hours</MenuItem>
          <MenuItem value={168}>7 days</MenuItem>
          <MenuItem value={720}>30 days</MenuItem>
          <MenuItem value="">Never</MenuItem>
        </TextField>
        <Button type="submit" variant="contained" disabled={!canManage || saving}>
          {saving ? "Creating…" : "Create invitation"}
        </Button>
      </Box>

      {generatedUrl && (
        <Box sx={{ mt: 2, p: 2, border: "1px solid var(--color-accent)", overflowWrap: "anywhere" }}>
          <Typography variant="caption" color="text.secondary">Copy this link now. The secret is not stored and cannot be shown again.</Typography>
          <Typography component="code" sx={{ display: "block", my: 1, fontFamily: "var(--font-mono)" }}>{generatedUrl}</Typography>
          <Button size="small" variant="outlined" onClick={() => navigator.clipboard.writeText(generatedUrl)}>Copy link</Button>
        </Box>
      )}

      {error && <Typography color="error" sx={{ mt: 2 }}>{error}</Typography>}
      {loading ? (
        <Typography color="text.secondary" sx={{ mt: 3 }}>Loading invitations…</Typography>
      ) : (
        <Box sx={{ display: "grid", gap: 1.5, mt: 3 }}>
          {invites.length === 0 && <Typography color="text.secondary">No invitations yet.</Typography>}
          {invites.map((invite) => {
            const exhausted = invite.redemptionCount >= invite.maxRedemptions;
            const expired = Boolean(invite.expiresAt && new Date(invite.expiresAt) <= new Date());
            const inactive = Boolean(invite.revokedAt) || exhausted || expired;
            return (
              <Box key={invite.id} sx={{ p: 2, border: "1px solid var(--color-sky-high)", opacity: inactive ? 0.6 : 1 }}>
                <Box sx={{ display: "flex", justifyContent: "space-between", gap: 2, flexWrap: "wrap" }}>
                  <Typography sx={{ fontFamily: "var(--font-mono)" }}>
                    {invite.redemptionCount}/{invite.maxRedemptions} redeemed
                    {invite.revokedAt ? " · revoked" : expired ? " · expired" : exhausted ? " · exhausted" : " · active"}
                  </Typography>
                  <Button size="small" color="error" variant="outlined" disabled={inactive} onClick={() => revokeInvite(invite.id)}>
                    Revoke
                  </Button>
                </Box>
                <Typography variant="caption" color="text.secondary">
                  Invite {invite.codePrefix}… · Created {new Date(invite.createdAt).toLocaleString()}
                  {invite.expiresAt ? ` · expires ${new Date(invite.expiresAt).toLocaleString()}` : " · no expiry"}
                </Typography>
                {invite.redemptions.map((redemption) => (
                  <Typography key={redemption.userId} variant="body2" sx={{ mt: 1 }}>
                    {redemption.name || redemption.email} · {redemption.email} · {new Date(redemption.redeemedAt).toLocaleString()}
                  </Typography>
                ))}
              </Box>
            );
          })}
        </Box>
      )}
    </Box>
  );
}
