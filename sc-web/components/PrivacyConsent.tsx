"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Box, Button, Dialog, DialogActions, DialogContent, DialogTitle, Link as MuiLink, Stack, Typography } from "@mui/material";
import { clearLegacyAnalyticsStorage, OPEN_PRIVACY_CHOICES_EVENT, readPrivacyConsent, writePrivacyConsent, type PrivacyConsent } from "@/lib/privacy-consent";

export default function PrivacyConsent() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const consent = readPrivacyConsent();
    if (consent === null) clearLegacyAnalyticsStorage();
    setOpen(consent === null);
    const reopen = () => setOpen(true);
    window.addEventListener(OPEN_PRIVACY_CHOICES_EVENT, reopen);
    return () => window.removeEventListener(OPEN_PRIVACY_CHOICES_EVENT, reopen);
  }, []);

  function choose(value: PrivacyConsent) {
    writePrivacyConsent(value);
    setOpen(false);
  }

  return (
    <Dialog open={open} aria-labelledby="privacy-choices-title" maxWidth="sm" fullWidth>
      <DialogTitle id="privacy-choices-title">Your privacy choices</DialogTitle>
      <DialogContent>
        <Stack spacing={2}>
          <Typography>
            Sprite Cloud uses necessary first-party storage for sign-in, security, remembered game-server choices, and player preferences. These features do not require consent.
          </Typography>
          <Box>
            <Typography variant="subtitle1" sx={{ fontWeight: 700 }}>Optional analytics</Typography>
            <Typography color="text.secondary">
              If you allow it, pseudonymous pageview and interaction events are sent to the configured PostHog service. Session recording and typed-input capture are disabled. Analytics stays off unless you choose Allow analytics.
            </Typography>
          </Box>
          <Typography variant="body2" color="text.secondary">
            You can change this choice later using Privacy choices in the footer. See the{" "}
            <MuiLink component={Link} href="/cookies">Cookie &amp; storage notice</MuiLink> and{" "}
            <MuiLink component={Link} href="/privacy">Privacy policy</MuiLink>.
          </Typography>
        </Stack>
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 3, flexWrap: "wrap" }}>
        <Button onClick={() => choose("necessary")} color="inherit">Necessary only</Button>
        <Button onClick={() => choose("analytics")} variant="contained">Allow analytics</Button>
      </DialogActions>
    </Dialog>
  );
}
